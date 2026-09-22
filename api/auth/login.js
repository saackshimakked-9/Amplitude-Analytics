// POST /api/auth/login  { email, password }
// Lightweight gate: the email must end in the allowed domain (spyne.ai) AND the shared
// password must match DASHBOARD_PASSWORD. On success, sets a signed HttpOnly session cookie
// that /api/metrics verifies. Note: this checks email FORMAT + a shared password, it does
// not verify the person actually owns that mailbox.
const { sign, allowedDomain, gateConfigured, SESSION_COOKIE } = require("../../lib/session");

async function readBody(req) {
  if (req.body != null) return req.body;
  return await new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
    req.on("error", () => resolve(""));
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }
  if (!gateConfigured()) {
    // No password set: dashboard is open, nothing to unlock.
    res.status(200).json({ ok: true, note: "no_gate" });
    return;
  }
  let body = await readBody(req);
  if (typeof body === "string") {
    try { body = JSON.parse(body || "{}"); } catch { body = {}; }
  }
  const email = String((body && body.email) || "").trim().toLowerCase();
  const password = String((body && body.password) || "");
  const domain = allowedDomain();

  if (!email.endsWith("@" + domain)) {
    res.status(401).json({ ok: false, error: "bad_domain", message: `Use your @${domain} email address.` });
    return;
  }
  if (password !== process.env.DASHBOARD_PASSWORD) {
    res.status(401).json({ ok: false, error: "bad_password", message: "That password is not right." });
    return;
  }

  const token = sign({ email, exp: Date.now() + 8 * 60 * 60 * 1000 });
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800`
  );
  res.status(200).json({ ok: true });
};
