// "Sign in with Google" for a desktop app with no backend of our own.
//
// Google forbids OAuth inside embedded webviews (disallowed_useragent), so we
// follow their installed-app recipe: open the consent screen in the system
// browser, catch the redirect on a one-shot 127.0.0.1 listener, and exchange
// the code at the token endpoint with PKCE. Scopes are identity-only
// (openid email profile); we never request offline access, so no refresh
// token exists to store or protect.
//
// The client id/secret come from google-oauth.json at the repo root (shipped
// via extraResources when packaged). Google documents that for "Desktop app"
// OAuth clients the secret is not actually confidential — shipping it inside
// a public client is the sanctioned pattern.

const { shell } = require("electron");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { URL, URLSearchParams } = require("url");

const TIMEOUT_MS = 3 * 60 * 1000;

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function httpsJson(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error("HTTP " + res.statusCode + " from " + options.host + options.path + ": " + data.slice(0, 200)));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// Resolves with { sub, email, name, picture } or rejects (user closed the
// browser tab / denied / timeout). Safe to call again after a rejection.
function signIn(config) {
  return new Promise((resolve, reject) => {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));

    let settled = false;
    function finish(fn, arg) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        server.close();
      } catch (e) {}
      fn(arg);
    }

    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        '<html><body dir="rtl" style="font-family:sans-serif;text-align:center;padding-top:80px">' +
          "<h2>ההתחברות הושלמה 🌱</h2>אפשר לסגור את הלשונית הזו ולחזור לאקולוקו.</body></html>"
      );

      const err = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      if (err) {
        finish(reject, new Error("google returned error: " + err));
        return;
      }
      if (!code || u.searchParams.get("state") !== state) {
        finish(reject, new Error("bad oauth callback (missing code or state mismatch)"));
        return;
      }

      const port = server.address().port;
      const form = new URLSearchParams({
        code: code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: "http://127.0.0.1:" + port + "/callback",
        grant_type: "authorization_code",
        code_verifier: verifier,
      }).toString();

      httpsJson(
        {
          host: "oauth2.googleapis.com",
          path: "/token",
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(form),
          },
        },
        form
      )
        .then((tok) =>
          httpsJson({
            host: "openidconnect.googleapis.com",
            path: "/v1/userinfo",
            method: "GET",
            headers: { Authorization: "Bearer " + tok.access_token },
          })
        )
        .then((info) =>
          finish(resolve, { sub: info.sub, email: info.email, name: info.name, picture: info.picture })
        )
        .catch((e) => finish(reject, e));
    });

    const timer = setTimeout(() => finish(reject, new Error("sign-in timed out")), TIMEOUT_MS);

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: "http://127.0.0.1:" + port + "/callback",
        response_type: "code",
        scope: "openid email profile",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: state,
        prompt: "select_account",
      });
      shell.openExternal("https://accounts.google.com/o/oauth2/v2/auth?" + params.toString());
    });
  });
}

module.exports = { signIn };
