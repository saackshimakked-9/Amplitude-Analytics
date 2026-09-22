// Shared helpers for the email + shared-password gate. Lives outside /api so Vercel
// does not treat it as an endpoint; api/auth/login and api/metrics require it directly.
const crypto = require("crypto");

const SESSION_COOKIE = "dos_session";

const secret = () =>
  process.env.SESSION_SECRET || process.env.DASHBOARD_PASSWORD || "dealeros-dev-secret";

const allowedDomain = () => (process.env.ALLOWED_DOMAIN || "spyne.ai").toLowerCase();

// The gate is on only when a shared password is configured.
const gateConfigured = () => !!process.env.DASHBOARD_PASSWORD;

// Signed, tamper-proof session token: base64url(payload).hmac
function sign(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  return payload + "." + sig;
}

function verify(token) {
  if (!token || token.indexOf(".") < 0) return null;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let obj;
  try {
    obj = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return null;
  }
  if (!obj || !obj.exp || Date.now() > obj.exp) return null;
  return obj;
}

const readCookie = (req, name) => {
  const c = req.headers.cookie || "";
  const m = c.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
};

// Returns the verified session user ({email, name, exp}) or null.
function sessionUser(req) {
  const obj = verify(readCookie(req, SESSION_COOKIE));
  if (!obj || !obj.email) return null;
  if (!String(obj.email).toLowerCase().endsWith("@" + allowedDomain())) return null;
  return obj;
}

module.exports = {
  SESSION_COOKIE,
  allowedDomain,
  gateConfigured,
  sign,
  verify,
  readCookie,
  sessionUser,
};
