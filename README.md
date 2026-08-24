# Dealer OS Analytics Dashboard

A lightweight dashboard that pulls live numbers from Amplitude and displays them on a Spyne-branded page. Built to host on Vercel and later move to `analytics.spyne.ai`.

- `public/index.html` — the dashboard (static, no build step, Spyne Design System tokens).
- `api/metrics.js` — a serverless function that calls Amplitude's Dashboard REST API **server-side**, so the Amplitude secret key never reaches the browser.

If the API is unreachable (for example when you open the file locally), the page falls back to clearly labelled **sample** numbers, so you can preview the design before wiring up keys.

---

## What you need first
1. **Node.js** installed (for the Vercel CLI). Check with `node -v`.
2. **A Vercel account** (free). Sign up at [vercel.com](https://vercel.com) with GitHub. (I can't create this for you.)
3. **Amplitude API key + secret key** for the `spyneai` project: Amplitude → Settings → Projects → your project → **API Key** and **Secret Key**. Note your region (US or EU). Your project is on **US** (`api2.amplitude.com`).

---

## Deploy in 5 minutes (Vercel CLI)

```bash
npm i -g vercel
```

From inside this folder (`dealer-os-dashboard/`):

```bash
vercel
```

The first run opens your browser to log in, then asks a few questions (accept the defaults; it is a static project with functions, no framework). It returns a **preview URL** like `dealer-os-dashboard-xxxx.vercel.app`.

### Add your Amplitude keys and the dashboard password

```bash
vercel env add AMPLITUDE_API_KEY
vercel env add AMPLITUDE_SECRET_KEY
vercel env add DASHBOARD_PASSWORD     # the password people type to view the dashboard
# optional, only if your project is EU:
vercel env add AMPLITUDE_REGION       # value: eu
```

Paste each value when prompted and pick **Production** (and Preview, if you want the preview URL to show live data too). Choose any `DASHBOARD_PASSWORD` you like and share it with the people who should see the dashboard.

### Ship it to your main URL

```bash
vercel --prod
```

That promotes the deploy to your production URL. Re-run `vercel --prod` whenever you change files.

> Prefer no terminal? Push this folder to a GitHub repo, then on vercel.com click **Add New → Project → Import**, and add the same env vars under **Settings → Environment Variables**. After that every `git push` auto-deploys.

---

## Move it to analytics.spyne.ai

1. In the Vercel project: **Settings → Domains → Add** `analytics.spyne.ai`.
2. Vercel shows a DNS record (a `CNAME` pointing to `cname.vercel-dns.com`).
3. Whoever controls **spyne.ai DNS** (your eng/IT team) adds that record. Send them the exact value Vercel shows.
4. Once DNS propagates, the dashboard is live on `analytics.spyne.ai`.

> You almost certainly cannot edit `spyne.ai` DNS yourself, so this step is a short request to eng/IT with the CNAME from step 2. If `analytics.spyne.ai` is already a running platform, confirm who owns it before pointing the domain.

---

## Password gate (built in)
This project has its own password gate, so you do not need Vercel's paid Deployment Protection.
- Set `DASHBOARD_PASSWORD` (above). When it is set, opening the link shows a password screen. The data API (`/api/metrics`) returns nothing until the correct password is entered.
- The password is checked server-side by `api/login.js`, which sets a secure `HttpOnly` cookie valid for 8 hours. The password is never stored in the browser or the page source, so it cannot be bypassed by viewing source.
- To change the password later, update the `DASHBOARD_PASSWORD` env var in Vercel and redeploy.
- If you ever want the dashboard fully open, just remove the `DASHBOARD_PASSWORD` env var and the gate disappears.
- The page also carries a `noindex` tag so search engines skip it.

---

## What the dashboard shows
Executive view, last 30 days, with a **region lens** at the top:
- **View toggle: Clients (excl. India) · India (internal) · All.** India is mostly the internal team, so the dashboard defaults to **Clients** so the headline numbers reflect real customers (US/EU). The toggle re-scopes every KPI and every chart. Split is by Amplitude's built-in `country` property.
- **KPI strip:** Monthly active users, Daily active users, Stickiness (DAU/MAU), Avg session time, New users, all per the selected region.
- **Active users by region:** the internal vs client proportion, always visible.
- **Trends:** DAU by day, Avg session time by day, per region.
- **Top sections by users:** unique users per section, from the current `Page Viewed` grouped by `sub_tab`, per region.

### Region split availability
Active users, DAU/MAU trends, and stickiness split by region reliably (grouped by `country`). Session time, new users, and top sections use segment filters on the API. If Amplitude rejects a segment filter for one of those, that metric falls back to **all regions** and the tile is tagged "all regions" in blue, with the reason logged in `/api/metrics` `warnings`. Everything else still splits.

### Read this about the numbers
Per the analytics PRD, current instrumentation has known gaps:
- DAU/MAU today are **device-based** (Amplitude `user_id` is not set yet), so they count devices, not people. They become person and dealership accurate once the PRD ships.
- There is no `product` dimension yet, so per-product and per-dealership splits are not available. Active dealerships and unique devices arrive with v1 instrumentation.
- **Top sections** relies on the `sub_tab` property on `Page Viewed`, which is currently inconsistent. If Amplitude rejects that group-by, the card shows an empty state and the reason is logged in the JSON `warnings` array at `/api/metrics`. Adjust the property name in `api/metrics.js` if your taxonomy differs.

### Adding the PRD metrics later
Once events like `Nav Tab Clicked` are live, add queries to `api/metrics.js` using Amplitude's Event Segmentation endpoint, for example:

```
GET /events/segmentation?e={"event_type":"Nav Tab Clicked"}&start=YYYYMMDD&end=YYYYMMDD&m=totals&g=tab
```

Return the grouped series into a new field and render a tile/chart in `public/index.html`. Active dealerships (rooftops) are cleanest via Amplitude Group Analytics once `setGroup('rooftop', team_id)` is firing.

---

## Notes
- **No build step, no dependencies.** The function uses Node's built-in `fetch` (Node 18+, which Vercel provides).
- **Rate limits:** Amplitude's Dashboard REST API is rate-limited and has a cost concurrency budget. The function caches responses at Vercel's edge for 5 minutes to stay well within limits.
- **Icons:** this standalone page uses small inline SVGs to stay dependency-free. In the production component library, route icons through the Material Symbols wrapper per the design system.

## Local preview
Open `public/index.html` directly in a browser to see the layout with sample data, or run `vercel dev` to test the live function locally (needs the env vars in a local `.env`).
