// POST /api/login  { "password": "..." }
// Checks the password against DASHBOARD_PASSWORD (Vercel env var) and, on success,
// sets a secure HttpOnly cookie that /api/metrics verifies. The password itself is
// never stored in the cookie.
const crypto = require("crypto");

const tokenFor = (pw) =>
  crypto.createHmac("sha256", "dealeros-gate").update(pw).digest("base64url");

async function readBody(req) {
  if (req.body != null) return req.body;
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) {
    // No password configured: the dashboard is open, nothing to unlock.
    res.status(200).json({ ok: true, note: "no_password_configured" });
    return;
  }
  let body = await readBody(req);
  if (typeof body === "string") {
    try { body = JSON.parse(body || "{}"); } catch { body = {}; }
  }
  const pw = body && body.password;
  if (pw && pw === expected) {
    res.setHeader(
      "Set-Cookie",
      `dash=${tokenFor(expected)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800`
    );
    res.status(200).json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: "wrong_password" });
  }
};
