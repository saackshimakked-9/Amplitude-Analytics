// Vercel serverless function: GET /api/dealer-count?range=1|7|30
// EXACT distinct dealership count. Amplitude's group-by caps at 1,000 values, so we partition
// team_id by its first hex character (glob "x*") into 16 buckets (each well under the cap) and
// sum the distinct dealers per bucket. Lazy-loaded so it never blocks the dealer section.
const { sessionUser, gateConfigured } = require("../lib/session");

const BASE = { us: "https://amplitude.com/api/2", eu: "https://analytics.eu.amplitude.com/api/2" };
const yyyymmdd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");

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
  const get = async (path, tries = 7) => {
    for (let a = 0; a < tries; a++) {
      const r = await fetch(`${base}${path}`, { headers: { Authorization: auth } });
      if (r.status === 429) { await sleep(600 * (a + 1)); continue; }
      if (!r.ok) throw new Error(`${path.split("?")[0]} -> ${r.status}`);
      return r.json();
    }
    throw new Error("rate_limited");
  };
  const runPool = async (t, n) => { let i = 0; const w = async () => { while (i < t.length) { const my = i++; await t[my](); } }; await Promise.all(Array.from({ length: n }, w)); };

  const EMAIL_CLEAN = { prop: "gp:email_id", op: "does not contain", values: ["@spyne.ai"] };
  const prefixes = "0123456789abcdef".split("");
  const countPrefix = async (x, clean) => {
    const seg = clean ? [{ prop: "gp:team_id", op: "glob match", values: [x + "*"] }, EMAIL_CLEAN] : [{ prop: "gp:team_id", op: "glob match", values: [x + "*"] }];
    const j = await get(`/events/segmentation?e=${enc({ event_type: "_active" })}&m=uniques&i=${range}&start=${daysAgo(range + 5)}&end=${e}&g=${encodeURIComponent("gp:team_id")}&s=${enc(seg)}`);
    const labels = (j?.data?.seriesLabels || []).map((l) => Array.isArray(l) ? l[l.length - 1] : l);
    return { named: labels.filter((l) => l && l !== "(none)").length, capped: labels.length >= 1000 };
  };

  let cleanCount = 0, totalCount = 0, capped = false;
  const warnings = [];
  const jobs = [];
  prefixes.forEach((x) => {
    jobs.push(async () => { try { const r = await countPrefix(x, true); cleanCount += r.named; capped = capped || r.capped; } catch (err) { warnings.push(`clean_${x}: ${err.message}`); } });
    jobs.push(async () => { try { const r = await countPrefix(x, false); totalCount += r.named; capped = capped || r.capped; } catch (err) { warnings.push(`total_${x}: ${err.message}`); } });
  });
  await runPool(jobs, 4);

  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1200");
  res.status(200).json({ source: "amplitude", range, exact: { clean: cleanCount, total: totalCount }, capped, warnings });
};
