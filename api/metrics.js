// Vercel serverless function: GET /api/metrics
// Calls Amplitude's Dashboard REST API server-side so the secret key never reaches the browser.
// Every metric is computed for three buckets: all, india (internal), rest (clients: US/EU/other).
// Env: AMPLITUDE_API_KEY, AMPLITUDE_SECRET_KEY, optional AMPLITUDE_REGION ("us" default | "eu")
// Docs: https://www.docs.developers.amplitude.com/analytics/apis/dashboard-rest-api/

const crypto = require("crypto");

const BASE = {
  us: "https://amplitude.com/api/2",
  eu: "https://analytics.eu.amplitude.com/api/2",
};

const tokenFor = (pw) =>
  crypto.createHmac("sha256", "dealeros-gate").update(pw).digest("base64url");
const readCookie = (req, name) => {
  const c = req.headers.cookie || "";
  const m = c.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
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
const sumArr = (a) => (a || []).reduce((x, y) => x + (Number(y) || 0), 0);
const flatLabel = (l) => (Array.isArray(l) ? l.join(" / ") : l);
const addSeries = (a, b) => {
  const n = Math.max(a?.length || 0, b?.length || 0);
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) out[i] = (Number(a?.[i]) || 0) + (Number(b?.[i]) || 0);
  return out;
};
const tail = (a, n) => (a || []).slice(Math.max(0, (a || []).length - n));
const deltaPct = (now, prev) => (now != null && prev) ? Math.round(((now - prev) / prev) * 1000) / 10 : null;

module.exports = async (req, res) => {
  // Password gate: if DASHBOARD_PASSWORD is set, require the cookie from /api/login.
  const gate = process.env.DASHBOARD_PASSWORD;
  if (gate && readCookie(req, "dash") !== tokenFor(gate)) {
    res.status(401).json({ error: "unauthorized", message: "Enter the dashboard password." });
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

  const auth = "Basic " + Buffer.from(`${apiKey}:${secret}`).toString("base64");
  const end = new Date();
  const d30 = new Date(); d30.setDate(end.getDate() - 30);
  const d60 = new Date(); d60.setDate(end.getDate() - 60);
  const e = yyyymmdd(end), s30 = yyyymmdd(d30), s60 = yyyymmdd(d60);

  const get = async (path) => {
    const r = await fetch(`${base}${path}`, { headers: { Authorization: auth } });
    if (!r.ok) throw new Error(`${path.split("?")[0]} -> ${r.status}`);
    return r.json();
  };
  const warnings = [];
  const safe = async (label, fn) => {
    try { return await fn(); } catch (err) { warnings.push(`${label}: ${err.message}`); return null; }
  };
  const enc = (o) => encodeURIComponent(JSON.stringify(o));
  const S_INDIA = enc([{ prop: "country", op: "is", values: ["India"] }]);
  const S_REST  = enc([{ prop: "country", op: "is not", values: ["India"] }]);

  // Split a grouped-by-country segmentation response into india / rest / all daily series.
  const bucketByCountry = (resp) => {
    const out = { india: [], rest: [], all: [], labels: labelsFromXValues(resp?.data?.xValues) };
    if (!resp?.data?.series) return out;
    const labels = (resp.data.seriesLabels || []).map(flatLabel);
    resp.data.series.forEach((series, i) => {
      const arr = (series || []).map(Number);
      if (String(labels[i]).toLowerCase() === "india") out.india = addSeries(out.india, arr);
      else out.rest = addSeries(out.rest, arr);
    });
    out.all = addSeries(out.india, out.rest);
    return out;
  };

  // ---- active users, grouped by country (DAU daily + MAU rolling), 60d for deltas ----
  const dauGeo = await safe("dau_geo", () =>
    get(`/events/segmentation?e=${enc({ event_type: "_active" })}&m=uniques&i=1&g=country&start=${s60}&end=${e}`));
  const mauGeo = await safe("mau_geo", () =>
    get(`/events/segmentation?e=${enc({ event_type: "_active" })}&m=uniques&i=30&g=country&start=${s60}&end=${e}`));

  const db = bucketByCountry(dauGeo);
  const mb = bucketByCountry(mauGeo);

  const bucketMetric = (bk) => {
    const now = lastNonNull(bk);
    const prev = bk && bk.length > 31 ? bk[bk.length - 31] : null;
    return { value: now, delta: deltaPct(now, prev) };
  };
  const dau = { all: bucketMetric(db.all), india: bucketMetric(db.india), rest: bucketMetric(db.rest) };
  const mau = { all: bucketMetric(mb.all), india: bucketMetric(mb.india), rest: bucketMetric(mb.rest) };

  const dauTrend = {
    labels: tail(db.labels, 30),
    all: tail(db.all, 30), india: tail(db.india, 30), rest: tail(db.rest, 30),
  };

  // ---- new users, grouped by country (30d totals) ----
  const newGeo = await safe("new_geo", () =>
    get(`/users?start=${s30}&end=${e}&m=new&i=1&g=country`));
  let newUsers = { all: null, india: null, rest: null };
  if (newGeo) {
    const nb = bucketByCountry(newGeo);
    newUsers = { all: sumArr(nb.all), india: sumArr(nb.india), rest: sumArr(nb.rest) };
  } else {
    const newAll = await safe("new_all", () => get(`/users?start=${s30}&end=${e}&m=new&i=1`));
    newUsers = { all: sumArr(newAll?.data?.series?.[0]), india: null, rest: null };
  }

  // ---- avg session length per bucket (segment filters) ----
  const sess = async (s) => {
    const q = s ? `&s=${s}` : "";
    return get(`/sessions/average?start=${s30}&end=${e}${q}`);
  };
  const sAll = await safe("session_all", () => sess(null));
  const sIndia = await safe("session_india", () => sess(S_INDIA));
  const sRest = await safe("session_rest", () => sess(S_REST));
  const sessSeries = (r) => (r?.data?.series?.[0] || []).map(Number);
  const sessLabels = labelsFromXValues(sAll?.data?.xValues);
  const toMin = (a) => a.map((v) => Math.round((v / 60) * 10) / 10);
  const avgSessionSec = {
    all: lastNonNull(sessSeries(sAll)),
    india: sIndia ? lastNonNull(sessSeries(sIndia)) : null,
    rest: sRest ? lastNonNull(sessSeries(sRest)) : null,
  };
  const sessionTrend = {
    labels: sessLabels,
    all: toMin(sessSeries(sAll)),
    india: sIndia ? toMin(sessSeries(sIndia)) : null,
    rest: sRest ? toMin(sessSeries(sRest)) : null,
  };

  // ---- nav tab clicks: unique users per tab (Nav_Tab_Clicked by tab) per bucket ----
  const tabsSeg = async (s) => {
    const q = s ? `&s=${s}` : "";
    return get(`/events/segmentation?e=${enc({ event_type: "Nav_Tab_Clicked" })}&m=uniques&i=30&g=tab&start=${s30}&end=${e}${q}`);
  };
  const parseTabs = (resp) => {
    if (!resp?.data?.series) return [];
    const labels = (resp.data.seriesLabels || []).map(flatLabel);
    return resp.data.series
      .map((series, i) => ({ name: labels[i] || "Unknown", users: lastNonNull(series) || 0 }))
      .filter((t) => t.users > 0)
      .sort((a, b) => b.users - a.users)
      .slice(0, 10);
  };
  const tAll = await safe("tabs_all", () => tabsSeg(null));
  const tIndia = await safe("tabs_india", () => tabsSeg(S_INDIA));
  const tRest = await safe("tabs_rest", () => tabsSeg(S_REST));
  const tabs = { all: parseTabs(tAll), india: tIndia ? parseTabs(tIndia) : null, rest: tRest ? parseTabs(tRest) : null };

  // region proportion card (from MAU buckets)
  const iM = mau.india.value || 0, rM = mau.rest.value || 0, tot = iM + rM;
  const regionShare = tot ? {
    india: iM, rest: rM, total: tot,
    indiaShare: Math.round((iM / tot) * 1000) / 10,
    restShare: Math.round((rM / tot) * 1000) / 10,
  } : null;

  // ---- product output (daily totals of key product events) ----
  // Grounded in the live Amplitude taxonomy: VIN capture, media processing, studio sessions.
  const eventTotals = async (eventType) => {
    const r = await safe(`total_${eventType}`, () =>
      get(`/events/segmentation?e=${enc({ event_type: eventType })}&m=totals&i=1&start=${s30}&end=${e}`));
    const series = (r?.data?.series?.[0] || []).map(Number);
    const labels = labelsFromXValues(r?.data?.xValues);
    return { total: sumArr(series), trend: { labels: tail(labels, 30), values: tail(series, 30) } };
  };
  // Try primary event name, fall back to an alternate if it has no volume.
  const firstWithVolume = async (names) => {
    let out = { total: 0, trend: { labels: [], values: [] }, source: null };
    for (const n of names) {
      const r = await eventTotals(n);
      if (r.total > 0) return { ...r, source: n };
      if (!out.source) out = { ...r, source: n };
    }
    return out;
  };
  const productOutput = {
    vehiclesCaptured: await firstWithVolume(["vin_captured", "vin_details_saved"]),
    mediaProcessed: await firstWithVolume(["first_media_processing_time"]),
    studioSessions: await firstWithVolume(["virtual_studio_home", "virtual_studio_landed"]),
  };

  // ---- platform split: Web vs Mobile (active users) ----
  const platSeg = await safe("platform", () =>
    get(`/events/segmentation?e=${enc({ event_type: "_active" })}&m=uniques&i=30&g=platform&start=${s30}&end=${e}`));
  let platform = null;
  if (platSeg?.data?.series) {
    const labels = (platSeg.data.seriesLabels || []).map(flatLabel);
    let web = 0, mobile = 0;
    platSeg.data.series.forEach((series, i) => {
      const v = lastNonNull(series) || 0;
      const l = String(labels[i]).toLowerCase();
      if (l.includes("web")) web += v; else mobile += v;
    });
    const t = web + mobile;
    platform = t ? { web, mobile, total: t, webShare: Math.round((web / t) * 1000) / 10, mobileShare: Math.round((mobile / t) * 1000) / 10 } : null;
  }

  const payload = {
    source: "amplitude",
    region,
    updatedAt: new Date().toISOString(),
    window: { start: s30, end: e },
    metrics: { mau, dau, newUsers, avgSessionSec },
    dauTrend, sessionTrend, tabs, regionShare,
    productOutput, platform,
    splitFlags: {
      session: !!(sIndia && sRest),
      newUsers: !!newGeo,
      tabs: !!(tIndia && tRest),
    },
    warnings,
  };

  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  res.status(200).json(payload);
};
