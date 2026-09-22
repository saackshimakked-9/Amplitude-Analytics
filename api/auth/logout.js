// GET /api/auth/logout — clear the session cookie and return to the dashboard.
const { SESSION_COOKIE } = require("../../lib/session");

module.exports = async (req, res) => {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`
  );
  res.writeHead(302, { Location: "/" });
  res.end();
};
