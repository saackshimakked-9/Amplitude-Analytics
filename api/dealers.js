// Vercel serverless function: GET /api/dealers?range=1|7|30
// Dealer-level rollup, grouped by the dealership identifier (Amplitude user property).
// Returns active dealers, total clicks (Nav_Tab_Clicked) and visits (session_start),
// plus the top dealers by clicks (descending). Clean = non-Spyne, total = everyone.
//
// DEALER_PROP: the property that identifies a dealership. `gp:team_id` (the rooftop id) is
// populated today. When the friendly dealer-name property is live, change this one constant.
const { sessionUser, gateConfigured } = require("../lib/session");

const BASE = {
  us: "https://amplitude.com/api/2",
  eu: "https://analytics.eu.amplitude.com/api/2",
};
const DEALER_PROP = "gp:team_id";
const DEALER_LABEL_TYPE = "team_id"; // "team_id" (ids) | "name" (friendly) — matches DEALER_PROP

const yyyymmdd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const lastNonNull = (a) => { if (!a) return 0; for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return 0; };

module.exports = async (req, res) => {
  if (gateConfigured() && !sessionUser(req)) {
    res.status(401).json({ error: "unauthorized", message: "Sign in with your spyne.ai email." });
    return;
  }
  const apiKey = process.env.AMPLITUDE_API_KEY;
  const secret = process.env.AMPLITUDE_SECRET_KEY;
  const region = (process.env.AMPLITUDE_REGION || "us").toLowerCase();
  const base = BASE[region] || BASE.us;
  if (!apiKey || !secret) { res.status(500).json({ error: "missing_credentials" }); return; }

  const url = new URL(req.url, "http://localhost");
  const rangeRaw = Number(url.searchParams.get("range"));
  const range = [1, 7, 30].includes(rangeRaw) ? rangeRaw : 30;

  const auth = "Basic " + Buffer.from(`${apiKey}:${secret}`).toString("base64");
  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return yyyymmdd(d); };
  const e = yyyymmdd(new Date());
  const enc = (o) => encodeURIComponent(JSON.stringify(o));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const get = async (path, tries = 4) => {
    for (let a = 0; a < tries; a++) {
      const r = await fetch(`${base}${path}`, { headers: { Authorization: auth } });
      if (r.status === 429) { await sleep(400 * (a + 1)); continue; }
      if (!r.ok) throw new Error(`${path.split("?")[0]} -> ${r.status}`);
      return r.json();
    }
    throw new Error("rate_limited");
  };
  const runPool = async (thunks, size = 3) => { let i = 0; const w = async () => { while (i < thunks.length) { const my = i++; await thunks[my](); } }; await Promise.all(Array.from({ length: size }, w)); };
  const warnings = [];
  const cleanQ = "&s=" + enc([{ prop: "gp:email_id", op: "does not contain", values: ["@spyne.ai"] }]);

  // Group an event by the dealer property over the window (one rolling bucket). Returns {dealerId: value}.
  const byDealer = (event, m, clean) =>
    get(`/events/segmentation?e=${enc({ event_type: event })}&m=${m}&i=${range}&start=${daysAgo(range + 5)}&end=${e}&g=${encodeURIComponent(DEALER_PROP)}${clean ? cleanQ : ""}`)
      .then((j) => {
        const out = {};
        const labels = (j?.data?.seriesLabels || []).map((l) => Array.isArray(l) ? l[l.length - 1] : l);
        (j?.data?.series || []).forEach((s, i) => { out[labels[i]] = lastNonNull((s || []).map(Number)); });
        return out;
      });

  const store = {};
  const jobs = [
    ["clicksClean", () => byDealer("Nav_Tab_Clicked", "totals", true)],
    ["clicksTotal", () => byDealer("Nav_Tab_Clicked", "totals", false)],
    ["visitsClean", () => byDealer("session_start", "totals", true)],
    ["visitsTotal", () => byDealer("session_start", "totals", false)],
    ["activeClean", () => byDealer("_active", "uniques", true)],
    ["activeTotal", () => byDealer("_active", "uniques", false)],
  ];
  await runPool(jobs.map(([k, fn]) => async () => {
    try { store[k] = await fn(); } catch (err) { warnings.push(`${k}: ${err.message}`); store[k] = {}; }
  }), 3);

  const NONE = (k) => !k || k === "(none)";
  const namedKeys = (m) => Object.keys(m || {}).filter((k) => !NONE(k));
  const sumAll = (m) => Object.values(m || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  const pair = (c, t) => ({ clean: c, total: t });

  const activeDealers = pair(namedKeys(store.activeClean).length, namedKeys(store.activeTotal).length);
  const cappedClean = Object.keys(store.activeClean || {}).length >= 1000;
  const clicks = pair(sumAll(store.clicksClean), sumAll(store.clicksTotal));
  const visits = pair(sumAll(store.visitsClean), sumAll(store.visitsTotal));

  // Top dealers by clicks (clean), descending.
  const top = namedKeys(store.clicksClean)
    .map((id) => ({ dealer: id, clicks: Number(store.clicksClean[id]) || 0, visits: Number((store.visitsClean || {})[id]) || 0 }))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 15);

  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  res.status(200).json({
    source: "amplitude",
    range,
    labelType: DEALER_LABEL_TYPE,
    activeDealers,
    cappedClean,
    clicks,
    visits,
    top,
    warnings,
  });
};
