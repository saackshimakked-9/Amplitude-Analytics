// Vercel serverless function: GET /api/metrics?range=1|7|30
// Calls Amplitude's Dashboard REST API server-side so the secret key never reaches the browser.
// Two variants of every number are returned:
//   clean  = non-Spyne (user property email_id does NOT contain "@spyne.ai") -> the main figure
//   total  = everyone (incl. internal Spyne team)                            -> the subtitle
// The `range` param sets the window: 1 day (DAU), 7 days (weekly), 30 days (monthly).
// Env: AMPLITUDE_API_KEY, AMPLITUDE_SECRET_KEY, optional AMPLITUDE_REGION ("us" default | "eu")
// Docs: https://www.docs.developers.amplitude.com/analytics/apis/dashboard-rest-api/

const { sessionUser, gateConfigured } = require("../lib/session");

const BASE = {
  us: "https://amplitude.com/api/2",
  eu: "https://analytics.eu.amplitude.com/api/2",
};

const yyyymmdd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const labelsFromXValues = (x) =>
  (x || []).map((s) => {
    const p = String(s).split("-");
    return p.length === 3 ? `${Number(p[1])}/${Number(p[2])}` : s;
  });
const lastNonNull = (a) => {
  if (!a) return null;
  for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i];
  return null;
};
const avgNonNull = (a) => {
  const v = (a || []).filter((x) => x != null).map(Number);
  return v.length ? Math.round(v.reduce((x, y) => x + y, 0) / v.length) : null;
};

module.exports = async (req, res) => {
  // Access gate: when a shared password is configured, require a valid spyne.ai session.
  if (gateConfigured() && !sessionUser(req)) {
    res.status(401).json({ error: "unauthorized", message: "Sign in with your spyne.ai email." });
    return;
  }

  const apiKey = process.env.AMPLITUDE_API_KEY;
  const secret = process.env.AMPLITUDE_SECRET_KEY;
  const region = (process.env.AMPLITUDE_REGION || "us").toLowerCase();
  const base = BASE[region] || BASE.us;

  if (!apiKey || !secret) {
    res.status(500).json({
      error: "missing_credentials",
      message: "Set AMPLITUDE_API_KEY and AMPLITUDE_SECRET_KEY in Vercel. Until then the page shows sample data.",
    });
    return;
  }

  const url = new URL(req.url, "http://localhost");
  const rangeRaw = Number(url.searchParams.get("range"));
  const range = [1, 7, 30].includes(rangeRaw) ? rangeRaw : 30;
  const trendDays = range === 1 ? 7 : range; // a one-day line is a single dot, so show 7 days of context

  const auth = "Basic " + Buffer.from(`${apiKey}:${secret}`).toString("base64");
  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return yyyymmdd(d); };
  const e = yyyymmdd(new Date());

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Amplitude caps concurrent Dashboard API calls, so retry on 429 with backoff.
  const get = async (path, tries = 4) => {
    for (let a = 0; a < tries; a++) {
      const r = await fetch(`${base}${path}`, { headers: { Authorization: auth } });
      if (r.status === 429) { await sleep(400 * (a + 1)); continue; }
      if (!r.ok) throw new Error(`${path.split("?")[0]} -> ${r.status}`);
      return r.json();
    }
    throw new Error(`${path.split("?")[0]} -> 429 (rate limited)`);
  };
  // Run thunks with limited concurrency to stay under Amplitude's cap.
  const runPool = async (thunks, size = 3) => {
    let idx = 0;
    const worker = async () => { while (idx < thunks.length) { const my = idx++; await thunks[my](); } };
    await Promise.all(Array.from({ length: Math.min(size, thunks.length) }, worker));
  };
  const warnings = [];
  const safe = async (label, fn) => {
    try { return await fn(); } catch (err) { warnings.push(`${label}: ${err.message}`); return null; }
  };
  const enc = (o) => encodeURIComponent(JSON.stringify(o));

  // CLEAN filter: exclude the internal Spyne team by email domain (user property "email_id").
  const cleanQ = "&s=" + enc([{ prop: "gp:email_id", op: "does not contain", values: ["@spyne.ai"] }]);
  const ev_active = enc({ event_type: "_active" });
  const ev_tabG = enc({ event_type: "Nav_Tab_Clicked", group_by: [{ type: "event", value: "tab" }] });
  const firstSeries = (resp) => (resp?.data?.series?.[0] || []).map(Number);
  const groupVal = (l) => (Array.isArray(l) ? l[l.length - 1] : String(l).split(" / ").pop());
  const parseTabLast = (j) => {
    const out = {};
    const labels = (j?.data?.seriesLabels || []).map(groupVal);
    (j?.data?.series || []).forEach((s, i) => { out[labels[i]] = lastNonNull((s || []).map(Number)); });
    return out;
  };

  // Rolling unique active users ending today for interval i (1=DAU, 7=WAU, 30=MAU).
  const active = (i, clean) =>
    get(`/events/segmentation?e=${ev_active}&m=uniques&i=${i}&start=${daysAgo(i + 5)}&end=${e}${clean ? cleanQ : ""}`)
      .then((j) => lastNonNull(firstSeries(j)));
  // Avg session length over the window (mean of daily averages).
  const session = (clean) =>
    get(`/sessions/average?start=${daysAgo(range - 1)}&end=${e}${clean ? cleanQ : ""}`)
      .then((j) => avgNonNull(firstSeries(j)));
  // Per-tab metric across the window (one rolling bucket): m = uniques (clicks) or totals (views).
  const tabAgg = (m, clean) =>
    get(`/events/segmentation?e=${ev_tabG}&m=${m}&i=${range}&start=${daysAgo(range + 5)}&end=${e}${clean ? cleanQ : ""}`)
      .then(parseTabLast);
  // Daily active-user trend.
  const trendSeries = (clean) =>
    get(`/events/segmentation?e=${ev_active}&m=uniques&i=1&start=${daysAgo(trendDays - 1)}&end=${e}${clean ? cleanQ : ""}`);

  const iSet = Array.from(new Set([1, 30, range]));
  const store = {};
  const thunks = [];
  iSet.forEach((i) => {
    thunks.push(() => safe(`active_clean_${i}`, () => active(i, true)).then((v) => (store["ac" + i] = v)));
    thunks.push(() => safe(`active_total_${i}`, () => active(i, false)).then((v) => (store["at" + i] = v)));
  });
  thunks.push(() => safe("session_clean", () => session(true)).then((v) => (store.sc = v)));
  thunks.push(() => safe("session_total", () => session(false)).then((v) => (store.st = v)));
  thunks.push(() => safe("clicks_clean", () => tabAgg("uniques", true)).then((v) => (store.uc = v || {})));
  thunks.push(() => safe("clicks_total", () => tabAgg("uniques", false)).then((v) => (store.ut = v || {})));
  thunks.push(() => safe("views_clean", () => tabAgg("totals", true)).then((v) => (store.vc = v || {})));
  thunks.push(() => safe("views_total", () => tabAgg("totals", false)).then((v) => (store.vt = v || {})));
  thunks.push(() => safe("trend_clean", () => trendSeries(true)).then((j) => (store.tc = j)));
  thunks.push(() => safe("trend_total", () => trendSeries(false)).then((j) => (store.tt = j)));
  await runPool(thunks, 3);

  const pair = (c, t) => ({ clean: c ?? null, total: t ?? null });
  const dau = pair(store.ac1, store.at1);
  const mau = pair(store.ac30, store.at30);
  const activeSel = pair(store["ac" + range], store["at" + range]);
  const stick = (c, t) => (c != null && t ? Math.round((c / t) * 1000) / 10 : null);
  const stickiness = pair(stick(store.ac1, store.ac30), stick(store.at1, store.at30));

  // Per-tab table rows: unique clicks + page views (tab opens), clean main / total sub.
  const tabKeys = Array.from(new Set([
    ...Object.keys(store.uc || {}), ...Object.keys(store.ut || {}),
    ...Object.keys(store.vc || {}), ...Object.keys(store.vt || {}),
  ])).filter((k) => k && k !== "(none)" && k !== "0");
  const tabs = tabKeys.map((key) => ({
    key,
    clicks: pair(store.uc?.[key], store.ut?.[key]),
    views: pair(store.vc?.[key], store.vt?.[key]),
  }));
  const sumTab = (map) => Object.values(map || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  const tabOpens = pair(sumTab(store.vc), sumTab(store.vt));

  const trend = {
    labels: labelsFromXValues(store.tc?.data?.xValues),
    clean: firstSeries(store.tc),
    total: firstSeries(store.tt),
  };

  const payload = {
    source: "amplitude",
    region,
    auth: gateConfigured(),
    updatedAt: new Date().toISOString(),
    range,
    trendDays,
    filtered: "Main = non-Spyne (email_id excludes @spyne.ai). Subtitle = total incl. Spyne team.",
    metrics: { active: activeSel, dau, mau, stickiness, session: store.sc != null || store.st != null ? pair(store.sc, store.st) : pair(null, null), tabOpens },
    trend,
    tabs,
    warnings,
  };

  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  res.status(200).json(payload);
};
