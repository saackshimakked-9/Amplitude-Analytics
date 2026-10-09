// Vercel serverless function: GET /api/pages?range=1|7|30
// TRUE page views, from Amplitude autocapture "[Amplitude] Page Viewed" grouped by page path.
// This is the accurate page-view signal. Nav_Tab_Clicked only fires on an explicit tab click,
// so it undercounts default-landing pages like /home; this endpoint does not.
const { sessionUser, gateConfigured } = require("../lib/session");

const BASE = { us: "https://amplitude.com/api/2", eu: "https://analytics.eu.amplitude.com/api/2" };
const yyyymmdd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const lastNonNull = (a) => { if (!a) return 0; for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return 0; };

module.exports = async (req, res) => {
  if (gateConfigured() && !sessionUser(req)) { res.status(401).json({ error: "unauthorized" }); return; }
  const apiKey = process.env.AMPLITUDE_API_KEY, secret = process.env.AMPLITUDE_SECRET_KEY;
  const base = BASE[(process.env.AMPLITUDE_REGION || "us").toLowerCase()] || BASE.us;
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
  const runPool = async (t, n) => { let i = 0; const w = async () => { while (i < t.length) { const my = i++; await t[my](); } }; await Promise.all(Array.from({ length: n }, w)); };
  const cleanQ = "&s=" + enc([{ prop: "gp:email_id", op: "does not contain", values: ["@spyne.ai"] }]);
  const ev = enc({ event_type: "[Amplitude] Page Viewed", group_by: [{ type: "event", value: "[Amplitude] Page Path" }] });
  const groupVal = (l) => (Array.isArray(l) ? l[l.length - 1] : String(l).split(" / ").pop());

  const byPath = (m, clean) => get(`/events/segmentation?e=${ev}&m=${m}&i=${range}&start=${daysAgo(range + 5)}&end=${e}${clean ? cleanQ : ""}`)
    .then((j) => {
      const out = {};
      const labels = (j?.data?.seriesLabels || []).map(groupVal);
      (j?.data?.series || []).forEach((s, i) => { out[labels[i]] = lastNonNull((s || []).map(Number)); });
      return out;
    });

  const store = {}; const warnings = [];
  const jobs = [
    ["vc", () => byPath("totals", true)], ["vt", () => byPath("totals", false)],
    ["uc", () => byPath("uniques", true)], ["ut", () => byPath("uniques", false)],
  ];
  await runPool(jobs.map(([k, fn]) => async () => { try { store[k] = await fn(); } catch (err) { warnings.push(`${k}: ${err.message}`); store[k] = {}; } }), 3);

  const keys = Array.from(new Set(Object.keys(store.vc || {}))).filter((k) => k && k !== "(none)");
  const pages = keys
    .map((p) => ({ path: p, views: { clean: Number(store.vc[p]) || 0, total: Number((store.vt || {})[p]) || 0 }, viewers: { clean: Number((store.uc || {})[p]) || 0, total: Number((store.ut || {})[p]) || 0 } }))
    .sort((a, b) => b.views.clean - a.views.clean)
    .slice(0, 12);

  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  res.status(200).json({ source: "amplitude", range, event: "[Amplitude] Page Viewed", pages, warnings });
};
