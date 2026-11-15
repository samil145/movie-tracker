// Accounts: email + username + password (with email verification and reset links) and Sign in with Google.
// Everything lives in D1. Passwords are stored as salted PBKDF2 hashes; session and email tokens are stored
// only as SHA-256 hashes, so a database leak alone can't be replayed as a login.

export interface AuthEnv {
  DB: D1Database;
  AUTH_LIMITER: RateLimit;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  RESEND_API_KEY?: string;
  BREVO_API_KEY?: string;
  /** e.g. `Movie Tracker <you@example.com>` — must be a sender the email service has verified. */
  MAIL_FROM?: string;
}

export interface Session {
  user: PublicUser;
  tokenHash: string;
  /** Set when the session was extended: the caller must send this Set-Cookie back. */
  refresh?: string;
}

interface UserRow {
  id: string;
  email: string;
  username: string;
  pass: string | null;
  google_sub: string | null;
  avatar: string | null;
  verified: number;
  created_at: number;
}

export interface PublicUser {
  id: string;
  email: string;
  username: string;
  hasPassword: boolean;
  google: boolean;
  avatar: string | null;
  createdAt: number;
}

export const AUTH_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     email TEXT NOT NULL UNIQUE,
     username TEXT NOT NULL UNIQUE COLLATE NOCASE,
     pass TEXT,
     google_sub TEXT UNIQUE,
     avatar TEXT,
     verified INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)`,
  `CREATE TABLE IF NOT EXISTS tokens (
     token_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS user_items (
     user_id TEXT NOT NULL,
     key TEXT NOT NULL,
     data TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, key)
   )`,
];

const DAY = 86_400_000;
const COOKIE = "mt_session";
const OAUTH_COOKIE = "mt_oauth";
const SESSION_DAYS = 30; // you stay signed in while you keep using the app…
const SESSION_MAX_DAYS = 180; // …but every session ends after six months and asks for a fresh sign-in
const VERIFY_HOURS = 24;
const RESET_HOURS = 1;
const PBKDF2_ITERATIONS = 100_000; // the most Workers' WebCrypto allows

const json = (data: unknown, status = 200, headers?: Headers | Record<string, string>) => {
  const h = new Headers(headers);
  h.set("content-type", "application/json; charset=utf-8");
  h.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { status, headers: h });
};
const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);

/* ---------- crypto helpers ---------- */

const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const sha256 = async (s: string) => b64url(await crypto.subtle.digest("SHA-256", enc.encode(s)));

async function pbkdf2(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(await pbkdf2(password, salt, PBKDF2_ITERATIONS))}`;
}

async function checkPassword(password: string, stored: string | null) {
  if (!stored) return false;
  const [scheme, iterations, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2") return false;
  const got = await pbkdf2(password, unb64url(salt), Number(iterations));
  const want = unb64url(hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

/* ---------- validation (the sign-up screen shows the same rules) ---------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

const cleanEmail = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
const validEmail = (email: string) => email.length <= 254 && EMAIL_RE.test(email);

function passwordProblem(p: unknown): string | null {
  if (typeof p !== "string") return "Enter a password.";
  if (p.length < 8) return "Password needs at least 8 characters.";
  if (p.length > 128) return "Password is too long.";
  if (!/[a-z]/.test(p) || !/[A-Z]/.test(p)) return "Password needs an uppercase and a lowercase letter.";
  if (!/\d/.test(p)) return "Password needs a number.";
  return null;
}

/* ---------- cookies & sessions ---------- */

function readCookie(req: Request, name: string) {
  const m = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

function cookie(req: Request, name: string, value: string, maxAgeSeconds: number) {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}${secure}`;
}

const toPublic = (u: UserRow): PublicUser => ({
  id: u.id,
  email: u.email,
  username: u.username,
  hasPassword: Boolean(u.pass),
  google: Boolean(u.google_sub),
  avatar: u.avatar,
  createdAt: u.created_at,
});

async function startSession(req: Request, env: AuthEnv, userId: string) {
  const token = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(
      await sha256(token),
      userId,
      now,
      now + SESSION_DAYS * DAY,
    ),
  ]);
  return cookie(req, COOKIE, token, SESSION_DAYS * 86_400);
}

export async function currentSession(req: Request, env: AuthEnv): Promise<Session | null> {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    "SELECT s.created_at AS s_created, s.expires_at AS s_expires, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
  )
    .bind(tokenHash)
    .first<UserRow & { s_created: number; s_expires: number }>();
  const now = Date.now();
  if (!row || row.s_expires < now) return null;

  // Sliding expiry: push the end date out about once a week of use, never past the six-month hard stop.
  let refresh: string | undefined;
  if (row.s_expires - now < (SESSION_DAYS - 7) * DAY) {
    const next = Math.min(now + SESSION_DAYS * DAY, row.s_created + SESSION_MAX_DAYS * DAY);
    if (next > row.s_expires) {
      await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").bind(next, tokenHash).run();
      refresh = cookie(req, COOKIE, token, (next - now) / 1000);
    }
  }
  return { user: toPublic(row), tokenHash, refresh };
}

/* ---------- email ---------- */

const mailReady = (env: AuthEnv) => Boolean(env.MAIL_FROM && (env.RESEND_API_KEY || env.BREVO_API_KEY));
const isLocal = (req: Request) => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(req.url).hostname);

function mailHtml(heading: string, body: string, button: string, link: string) {
  return `<!doctype html><html><body style="margin:0;background:#0a0d1c;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0d1c;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background:#131830;border:1px solid #283056;border-radius:16px;padding:32px">
<tr><td style="color:#ff6a4d;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding-bottom:14px">Movie Tracker</td></tr>
<tr><td style="color:#f1f3ff;font-size:24px;font-weight:700;line-height:1.2;padding-bottom:12px">${heading}</td></tr>
<tr><td style="color:#c9cfea;font-size:16px;line-height:1.5;padding-bottom:26px">${body}</td></tr>
<tr><td><a href="${link}" style="display:inline-block;background:#ff5a5f;color:#1c0612;font-weight:700;font-size:16px;text-decoration:none;padding:14px 24px;border-radius:12px">${button}</a></td></tr>
<tr><td style="color:#636c94;font-size:13px;line-height:1.5;padding-top:26px">If the button doesn't work, paste this into your browser:<br><span style="color:#98a1c8;word-break:break-all">${link}</span></td></tr>
</table></td></tr></table></body></html>`;
}

async function sendMail(env: AuthEnv, to: string, subject: string, html: string, text: string) {
  const from = env.MAIL_FROM!.trim();
  let res: Response;
  if (env.RESEND_API_KEY) {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
    });
  } else {
    const m = from.match(/^(.*)<([^>]+)>$/);
    const sender = m ? { name: m[1].trim() || "Movie Tracker", email: m[2].trim() } : { name: "Movie Tracker", email: from };
    res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env.BREVO_API_KEY!, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender, to: [{ email: to }], subject, htmlContent: html, textContent: text }),
    });
  }
  if (!res.ok) {
    console.error("mail failed", res.status, (await res.text()).slice(0, 300));
    throw new MailError();
  }
}
class MailError extends Error {}

/** Create a single-use emailed link and send it. Returns the link itself only on a local dev server with no mail set up. */
async function sendLink(req: Request, env: AuthEnv, user: UserRow, kind: "verify" | "reset") {
  const token = randomToken();
  const hours = kind === "verify" ? VERIFY_HOURS : RESET_HOURS;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM tokens WHERE (user_id = ? AND kind = ?) OR expires_at < ?").bind(user.id, kind, Date.now()),
    env.DB.prepare("INSERT INTO tokens (token_hash, user_id, kind, expires_at) VALUES (?, ?, ?, ?)").bind(
      await sha256(token),
      user.id,
      kind,
      Date.now() + hours * 3_600_000,
    ),
  ]);
  const link = `${new URL(req.url).origin}/#/${kind}/${token}`;

  if (!mailReady(env)) {
    if (isLocal(req)) {
      console.log(`[dev] ${kind} link for ${user.email}: ${link}`);
      return link;
    }
    throw new MailError();
  }

  if (kind === "verify") {
    await sendMail(
      env,
      user.email,
      "Confirm your email for Movie Tracker",
      mailHtml(`Welcome, ${user.username}`, "Confirm this is your email address to finish creating your account. The link works for 24 hours.", "Confirm email", link),
      `Welcome, ${user.username}. Confirm your email to finish creating your Movie Tracker account (link works for 24 hours):\n${link}`,
    );
  } else {
    await sendMail(
      env,
      user.email,
      "Reset your Movie Tracker password",
      mailHtml("Reset your password", "Choose a new password with the button below. The link works for 1 hour. If you didn't ask for this, ignore this email and nothing changes.", "Choose a new password", link),
      `Choose a new Movie Tracker password (link works for 1 hour):\n${link}\nIf you didn't ask for this, ignore this email.`,
    );
  }
  return null;
}

async function useToken(env: AuthEnv, token: unknown, kind: "verify" | "reset") {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
  const hash = await sha256(token);
  const row = await env.DB.prepare(
    "SELECT u.* FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.kind = ? AND t.expires_at > ?",
  )
    .bind(hash, kind, Date.now())
    .first<UserRow>();
  if (!row) return null;
  await env.DB.prepare("DELETE FROM tokens WHERE token_hash = ?").bind(hash).run();
  return row;
}

/* ---------- users ---------- */

const byEmail = (env: AuthEnv, email: string) => env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>();
const byUsername = (env: AuthEnv, username: string) =>
  env.DB.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").bind(username).first<UserRow>();

async function createUser(env: AuthEnv, u: Omit<UserRow, "id" | "created_at">): Promise<UserRow> {
  const row: UserRow = { ...u, id: crypto.randomUUID(), created_at: Date.now() };
  const first = (await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())?.n === 0;
  await env.DB.prepare(
    "INSERT INTO users (id, email, username, pass, google_sub, avatar, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(row.id, row.email, row.username, row.pass, row.google_sub, row.avatar, row.verified, row.created_at)
    .run();
  // The app began life with one shared list and no accounts. Whoever signs up first is its owner and inherits it.
  if (first) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO user_items (user_id, key, data, updated_at) SELECT ?, key, data, updated_at FROM items",
    )
      .bind(row.id)
      .run()
      .catch(() => {});
  }
  return row;
}

async function freeUsername(env: AuthEnv, wanted: string) {
  let base = wanted.replace(/[^A-Za-z0-9_]/g, "").slice(0, 16);
  if (base.length < 3) base = `viewer${base}`;
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? base : `${base}${Math.floor(Math.random() * 9000 + 1000)}`;
    if (!(await byUsername(env, candidate))) return candidate;
  }
  return `viewer${Date.now().toString(36)}`;
}

/* ---------- Google ---------- */

const googleReady = (env: AuthEnv) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

function googleStart(req: Request, env: AuthEnv) {
  const url = new URL(req.url);
  const state = randomToken();
  const to = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  to.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!.trim(),
    redirect_uri: `${url.origin}/api/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  }).toString();
  return new Response(null, { status: 302, headers: { location: to.toString(), "set-cookie": cookie(req, OAUTH_COOKIE, state, 600) } });
}

async function googleCallback(req: Request, env: AuthEnv) {
  const url = new URL(req.url);
  const back = (error?: string, session?: string) => {
    const h = new Headers({ location: error ? `/?auth_error=${error}` : "/" });
    h.append("set-cookie", cookie(req, OAUTH_COOKIE, "", 0));
    if (session) h.append("set-cookie", session);
    return new Response(null, { status: 302, headers: h });
  };

  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  // The person pressed Cancel, or Google refused before asking them.
  if (url.searchParams.get("error")) return back(url.searchParams.get("error") === "access_denied" ? "google_cancel" : "google");
  if (!code || !state || state !== readCookie(req, OAUTH_COOKIE)) return back("google_state");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!.trim(),
      client_secret: env.GOOGLE_CLIENT_SECRET!.trim(),
      redirect_uri: `${url.origin}/api/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    // Google's error code only ("invalid_client" = wrong ID or secret); never the keys themselves.
    const why = ((await tokenRes.json().catch(() => null)) as { error?: string } | null)?.error ?? String(tokenRes.status);
    console.error("google token exchange failed:", why);
    return back(why === "invalid_client" || why === "unauthorized_client" ? "google_keys" : "google");
  }
  const { access_token } = (await tokenRes.json()) as { access_token?: string };
  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${access_token}` } });
  if (!infoRes.ok) return back("google");
  const info = (await infoRes.json()) as { sub?: string; email?: string; email_verified?: boolean; picture?: string };
  const email = cleanEmail(info.email);
  if (!info.sub || !email || !info.email_verified) return back("google_email");

  let user = await env.DB.prepare("SELECT * FROM users WHERE google_sub = ?").bind(info.sub).first<UserRow>();
  if (!user) {
    const existing = await byEmail(env, email);
    if (existing) {
      // Same verified address: attach Google to the account that's already there.
      await env.DB.prepare("UPDATE users SET google_sub = ?, verified = 1, avatar = COALESCE(avatar, ?) WHERE id = ?")
        .bind(info.sub, info.picture ?? null, existing.id)
        .run();
      user = existing;
    } else {
      user = await createUser(env, {
        email,
        username: await freeUsername(env, email.split("@")[0]),
        pass: null,
        google_sub: info.sub,
        avatar: info.picture ?? null,
        verified: 1,
      });
    }
  }
  return back(undefined, await startSession(req, env, user.id));
}

/* ---------- routes ---------- */

const body = async (req: Request) => ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;

/** Handles every /api/auth/* and /api/me* route. Returns null for anything else. */
export async function handleAuth(req: Request, env: AuthEnv, path: string): Promise<Response | null> {
  const method = req.method;
  const url = new URL(req.url);
  if (!path.startsWith("/api/auth") && !path.startsWith("/api/me")) return null;

  // Tight budget for anything that takes a password, creates an account or sends an email.
  if (method === "POST" && path.startsWith("/api/auth/")) {
    const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
    if (!(await env.AUTH_LIMITER.limit({ key: ip })).success) {
      return fail(429, "Too many attempts. Wait a minute and try again.");
    }
  }

  try {
    if (path === "/api/auth/state" && method === "GET") {
      const session = await currentSession(req, env);
      return json({ user: session?.user ?? null, google: googleReady(env) }, 200, session?.refresh ? { "set-cookie": session.refresh } : undefined);
    }

    if (path === "/api/auth/check" && method === "GET") {
      const username = url.searchParams.get("username") ?? "";
      if (!USERNAME_RE.test(username)) return json({ available: false });
      return json({ available: !(await byUsername(env, username)) });
    }

    if (path === "/api/auth/google" && method === "GET") {
      return googleReady(env) ? googleStart(req, env) : fail(404, "Google sign-in isn't set up.");
    }
    if (path === "/api/auth/google/callback" && method === "GET") {
      return googleReady(env) ? googleCallback(req, env) : fail(404, "Google sign-in isn't set up.");
    }

    if (path === "/api/auth/signup" && method === "POST") {
      const b = await body(req);
      const email = cleanEmail(b.email);
      const username = typeof b.username === "string" ? b.username.trim() : "";
      if (!validEmail(email)) return fail(400, "Enter a valid email address.", { field: "email" });
      if (!USERNAME_RE.test(username)) return fail(400, "Usernames are 3–20 letters, numbers or underscores.", { field: "username" });
      const problem = passwordProblem(b.password);
      if (problem) return fail(400, problem, { field: "password" });

      const existing = await byEmail(env, email);
      if (existing?.verified) return fail(409, "An account with this email already exists. Sign in instead.", { field: "email" });
      const owner = await byUsername(env, username);
      if (owner && owner.id !== existing?.id) return fail(409, "That username is taken.", { field: "username" });

      const pass = await hashPassword(b.password as string);
      let user: UserRow;
      if (existing) {
        // Signed up before but never confirmed: let them start over with the new details.
        await env.DB.prepare("UPDATE users SET username = ?, pass = ? WHERE id = ?").bind(username, pass, existing.id).run();
        user = { ...existing, username, pass };
      } else {
        user = await createUser(env, { email, username, pass, google_sub: null, avatar: null, verified: 0 });
      }
      const devLink = await sendLink(req, env, user, "verify");
      return json({ ok: true, email, devLink });
    }

    if (path === "/api/auth/resend" && method === "POST") {
      const user = await byEmail(env, cleanEmail((await body(req)).email));
      const devLink = user && !user.verified ? await sendLink(req, env, user, "verify") : null;
      return json({ ok: true, devLink });
    }

    if (path === "/api/auth/verify" && method === "POST") {
      const user = await useToken(env, (await body(req)).token, "verify");
      if (!user) return fail(400, "This link has expired or was already used.");
      await env.DB.prepare("UPDATE users SET verified = 1 WHERE id = ?").bind(user.id).run();
      return json({ user: toPublic({ ...user, verified: 1 }) }, 200, { "set-cookie": await startSession(req, env, user.id) });
    }

    if (path === "/api/auth/login" && method === "POST") {
      const b = await body(req);
      const id = typeof b.identifier === "string" ? b.identifier.trim() : "";
      const password = typeof b.password === "string" ? b.password : "";
      if (!id || !password) return fail(400, "Enter your email or username and your password.");
      const user = id.includes("@") ? await byEmail(env, id.toLowerCase()) : await byUsername(env, id);
      if (!user || !(await checkPassword(password, user.pass))) return fail(401, "Wrong email, username or password.");
      if (!user.verified) {
        const devLink = await sendLink(req, env, user, "verify");
        return fail(403, "Confirm your email first. We just sent you a new link.", { code: "unverified", email: user.email, devLink });
      }
      return json({ user: toPublic(user) }, 200, { "set-cookie": await startSession(req, env, user.id) });
    }

    if (path === "/api/auth/forgot" && method === "POST") {
      const email = cleanEmail((await body(req)).email);
      if (!validEmail(email)) return fail(400, "Enter a valid email address.");
      const user = await byEmail(env, email);
      // Same answer whether or not the address has an account, so this can't be used to find out who signed up.
      const devLink = user ? await sendLink(req, env, user, "reset") : null;
      return json({ ok: true, devLink });
    }

    if (path === "/api/auth/reset" && method === "POST") {
      const b = await body(req);
      const problem = passwordProblem(b.password);
      if (problem) return fail(400, problem);
      const user = await useToken(env, b.token, "reset");
      if (!user) return fail(400, "This link has expired or was already used. Ask for a new one.");
      await env.DB.batch([
        // Clicking an emailed link also proves the address, and a new password ends every old session.
        env.DB.prepare("UPDATE users SET pass = ?, verified = 1 WHERE id = ?").bind(await hashPassword(b.password as string), user.id),
        env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
      ]);
      const fresh = { ...user, pass: "set", verified: 1 };
      return json({ user: toPublic(fresh) }, 200, { "set-cookie": await startSession(req, env, user.id) });
    }

    if (path === "/api/auth/logout" && method === "POST") {
      const session = await currentSession(req, env);
      if (session) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(session.tokenHash).run();
      return json({ ok: true }, 200, { "set-cookie": cookie(req, COOKIE, "", 0) });
    }

    /* ----- signed-in account management ----- */

    if (path.startsWith("/api/me")) {
      const session = await currentSession(req, env);
      if (!session) return fail(401, "Sign in to continue.");
      const me = (await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(session.user.id).first<UserRow>())!;

      if (path === "/api/me" && method === "PATCH") {
        const username = String((await body(req)).username ?? "").trim();
        if (!USERNAME_RE.test(username)) return fail(400, "Usernames are 3–20 letters, numbers or underscores.");
        const owner = await byUsername(env, username);
        if (owner && owner.id !== me.id) return fail(409, "That username is taken.");
        await env.DB.prepare("UPDATE users SET username = ? WHERE id = ?").bind(username, me.id).run();
        return json({ user: toPublic({ ...me, username }) });
      }

      if (path === "/api/me/password" && method === "POST") {
        const b = await body(req);
        if (me.pass && !(await checkPassword(String(b.current ?? ""), me.pass))) return fail(403, "Your current password is wrong.");
        const problem = passwordProblem(b.password);
        if (problem) return fail(400, problem);
        await env.DB.batch([
          env.DB.prepare("UPDATE users SET pass = ? WHERE id = ?").bind(await hashPassword(b.password as string), me.id),
          env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(me.id, session.tokenHash),
        ]);
        return json({ user: toPublic({ ...me, pass: "set" }) });
      }

      if (path === "/api/me/sessions" && method === "DELETE") {
        await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(me.id).run();
        return json({ ok: true }, 200, { "set-cookie": cookie(req, COOKIE, "", 0) });
      }

      if (path === "/api/me" && method === "DELETE") {
        if (String((await body(req)).confirm ?? "").toLowerCase() !== me.username.toLowerCase()) {
          return fail(400, "Type your username to confirm.");
        }
        await env.DB.batch([
          env.DB.prepare("DELETE FROM user_items WHERE user_id = ?").bind(me.id),
          env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(me.id),
          env.DB.prepare("DELETE FROM tokens WHERE user_id = ?").bind(me.id),
          env.DB.prepare("DELETE FROM users WHERE id = ?").bind(me.id),
        ]);
        return json({ ok: true }, 200, { "set-cookie": cookie(req, COOKIE, "", 0) });
      }
    }
  } catch (e) {
    if (e instanceof MailError) {
      return fail(503, mailReady(env) ? "We couldn't send the email. Try again in a minute." : "Email sending isn't set up yet, so this can't be completed.");
    }
    throw e;
  }

  return fail(404, "Not found.");
}
