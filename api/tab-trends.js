// Vercel serverless function: GET /api/tab-trends?days=7|30|60
// Daily page clicks (Nav_Tab_Clicked totals) per tab, non-Spyne only, for the collapsible
// trends section. Kept separate from /api/metrics so the section can lazy-load on expand.
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

module.exports = async (req, res) => {
  if (gateConfigured() && !sessionUser(req)) {
    res.status(401).json({ error: "unauthorized", message: "Sign in with your spyne.ai email." });
    return;
  }
  const apiKey = process.env.AMPLITUDE_API_KEY;
  const secret = process.env.AMPLITUDE_SECRET_KEY;
  const region = (process.env.AMPLITUDE_REGION || "us").toLowerCase();
  const base = BASE[region] || BASE.us;
  if (!apiKey || !secret) {
    res.status(500).json({ error: "missing_credentials" });
    return;
  }

  const url = new URL(req.url, "http://localhost");
  const dRaw = Number(url.searchParams.get("days"));
  const days = [7, 30, 60].includes(dRaw) ? dRaw : 30;

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

  const cleanQ = "&s=" + enc([{ prop: "gp:email_id", op: "does not contain", values: ["@spyne.ai"] }]);
  const ev = enc({ event_type: "Nav_Tab_Clicked", group_by: [{ type: "event", value: "tab" }] });
  const groupVal = (l) => (Array.isArray(l) ? l[l.length - 1] : String(l).split(" / ").pop());

  const warnings = [];
  let labels = [], series = {};
  try {
    const j = await get(`/events/segmentation?e=${ev}&m=totals&i=1&start=${daysAgo(days - 1)}&end=${e}${cleanQ}`);
    labels = labelsFromXValues(j?.data?.xValues);
    const segLabels = (j?.data?.seriesLabels || []).map(groupVal);
    (j?.data?.series || []).forEach((s, i) => { series[segLabels[i]] = (s || []).map(Number); });
  } catch (err) {
    warnings.push(String(err.message));
  }

  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  res.status(200).json({ source: "amplitude", days, filtered: "Non-Spyne (email_id excludes @spyne.ai)", labels, series, warnings });
};
