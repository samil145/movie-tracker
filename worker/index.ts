// Movie Tracker API — runs on Cloudflare Workers (free tier).
// Keeps the TMDB key server-side and stores each person's library in D1 so all their devices see the same lists.
// Accounts live in ./auth.ts. Abuse is bounded by per-visitor rate limits and hard caps on stored data.

import { AUTH_SCHEMA, currentSession, handleAuth, type AuthEnv } from "./auth";

interface Env extends AuthEnv {
  LIMITER: RateLimit;
  TMDB_KEY?: string;
}

type MediaType = "movie" | "tv";

const MAX_ITEMS = 3000; // per person; keeps the database far inside D1's free allowance

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });

const fail = (status: number, error: string) => json({ error }, status);

/* ---------- database ---------- */

let ready: Promise<unknown> | null = null;
function init(env: Env) {
  ready ??= env.DB.batch(
    [
      // The original single shared list, from before accounts existed. Kept so the first account can inherit it.
      "CREATE TABLE IF NOT EXISTS items (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)",
      ...AUTH_SCHEMA,
    ].map((sql) => env.DB.prepare(sql)),
  ).catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

/* ---------- TMDB ---------- */

class TmdbError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function tmdb(env: Env, path: string, params: Record<string, string> = {}): Promise<any> {
  const key = env.TMDB_KEY?.trim();
  if (!key) throw new TmdbError(500, "TMDB_KEY is not set on the server.");
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = { accept: "application/json" };
  // Works with either the long "API Read Access Token" (a JWT) or the short v3 key.
  if (key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
  else url.searchParams.set("api_key", key);

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { status_message?: string } | null;
    if (res.status === 404) throw new TmdbError(404, "Title not found.");
    if (res.status === 401) throw new TmdbError(502, "TMDB rejected the API key.");
    throw new TmdbError(502, body?.status_message ?? `TMDB error ${res.status}`);
  }
  return res.json();
}

const year = (date?: string | null) => (date ? Number(date.slice(0, 4)) || null : null);

function toHit(r: any, forced?: MediaType) {
  const type: MediaType = forced ?? r.media_type;
  return {
    type,
    id: r.id as number,
    title: (type === "movie" ? r.title : r.name) as string,
    year: year(type === "movie" ? r.release_date : r.first_air_date),
    poster: (r.poster_path ?? null) as string | null,
    overview: (r.overview ?? "") as string,
    popularity: (r.popularity ?? 0) as number,
  };
}

async function search(env: Env, q: string) {
  const data = await tmdb(env, "/search/multi", { query: q, include_adult: "false", page: "1" });
  return (data.results as any[])
    .filter((r) => r.media_type === "movie" || r.media_type === "tv")
    .map((r) => toHit(r));
}

async function trending(env: Env) {
  const data = await tmdb(env, "/trending/all/week");
  return (data.results as any[])
    .filter((r) => (r.media_type === "movie" || r.media_type === "tv") && r.poster_path)
    .slice(0, 18)
    .map((r) => toHit(r));
}

async function details(env: Env, type: MediaType, id: string) {
  const movie = type === "movie";
  const d = await tmdb(env, `/${type}/${id}`, {
    append_to_response: movie ? "credits,keywords,videos" : "aggregate_credits,keywords,videos",
  });

  const castRaw: any[] = (movie ? d.credits?.cast : d.aggregate_credits?.cast) ?? [];
  const videos: any[] = (d.videos?.results ?? []).filter((v: any) => v.site === "YouTube" && v.type === "Trailer");
  const trailer = videos.find((v) => v.official) ?? videos[0];
  const title: string = movie ? d.title : d.name;
  const original: string = movie ? d.original_title : d.original_name;

  return {
    type,
    id: d.id as number,
    title,
    originalTitle: original && original !== title ? original : null,
    year: year(movie ? d.release_date : d.first_air_date),
    endYear: movie || d.in_production ? null : year(d.last_air_date),
    runtime: (movie
      ? d.runtime || null
      : (d.episode_run_time?.[0] ?? d.last_episode_to_air?.runtime ?? null)) as number | null,
    seasons: movie ? null : ((d.number_of_seasons ?? null) as number | null),
    episodes: movie ? null : ((d.number_of_episodes ?? null) as number | null),
    ongoing: movie ? false : Boolean(d.in_production),
    poster: (d.poster_path ?? null) as string | null,
    backdrop: (d.backdrop_path ?? null) as string | null,
    genres: ((d.genres ?? []) as any[]).map((g) => g.name as string),
    keywords: ((d.keywords?.keywords ?? d.keywords?.results ?? []) as any[]).map((k) => k.name as string),
    tagline: (d.tagline || null) as string | null,
    overview: (d.overview ?? "") as string,
    rating: d.vote_count > 0 ? Math.round(d.vote_average * 10) / 10 : null,
    directors: movie
      ? ((d.credits?.crew ?? []) as any[]).filter((c) => c.job === "Director").map((c) => c.name as string)
      : ((d.created_by ?? []) as any[]).map((c) => c.name as string),
    cast: castRaw.slice(0, 12).map((c) => ({
      name: c.name as string,
      character: ((movie ? c.character : c.roles?.[0]?.character) || null) as string | null,
      photo: (c.profile_path ?? null) as string | null,
    })),
    trailer: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null,
  };
}

/* ---------- library ---------- */

const KEY_RE = /^(movie|tv):\d{1,10}$/;

async function listItems(env: Env, userId: string) {
  const { results } = await env.DB.prepare("SELECT data FROM user_items WHERE user_id = ?").bind(userId).all<{ data: string }>();
  return results.map((r) => JSON.parse(r.data));
}

async function putItem(req: Request, env: Env, userId: string, key: string) {
  const text = await req.text();
  if (text.length > 20_000) return fail(413, "Item too large.");
  let item: any;
  try {
    item = JSON.parse(text);
  } catch {
    return fail(400, "Invalid JSON.");
  }
  if (!item || item.key !== key || (item.status !== "watchlist" && item.status !== "watched")) {
    return fail(400, "Invalid item.");
  }
  const row = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM user_items WHERE user_id = ?1) AS total, EXISTS(SELECT 1 FROM user_items WHERE user_id = ?1 AND key = ?2) AS known",
  )
    .bind(userId, key)
    .first<{ total: number; known: number }>();
  if (row && !row.known && row.total >= MAX_ITEMS) return fail(507, "Your library is full.");

  await env.DB.prepare(
    "INSERT INTO user_items (user_id, key, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
  )
    .bind(userId, key, JSON.stringify(item), Date.now())
    .run();
  return json({ ok: true });
}

/* ---------- router ---------- */

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = req.method;

  // One budget per visitor for the whole API. Generous enough for a big list import,
  // far too small to hammer TMDB or burn through Cloudflare's free daily allowance.
  const visitor = req.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.LIMITER.limit({ key: visitor });
  if (!success) return json({ error: "Too many requests. Give it a minute." }, 429, { "retry-after": "60" });

  // Changes must come from our own pages. Together with SameSite cookies this shuts out cross-site requests.
  const origin = req.headers.get("origin");
  if (method !== "GET" && origin && new URL(origin).host !== url.host) return fail(403, "Cross-site request refused.");

  await init(env);

  const auth = await handleAuth(req, env, path);
  if (auth) return auth;

  // The sign-in screen shows this week's posters, so trending is the one thing visitors can read.
  if (path === "/api/trending" && method === "GET") return json(await trending(env));

  const session = await currentSession(req, env);
  if (!session) return fail(401, "Sign in to continue.");
  const res = await signedIn(req, env, url, path, method, session.user.id);
  if (session.refresh) res.headers.append("set-cookie", session.refresh);
  return res;
}

async function signedIn(req: Request, env: Env, url: URL, path: string, method: string, userId: string): Promise<Response> {
  if (path === "/api/search" && method === "GET") {
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
    return json(q ? await search(env, q) : []);
  }

  const title = path.match(/^\/api\/title\/(movie|tv)\/(\d{1,10})$/);
  if (title && method === "GET") return json(await details(env, title[1] as MediaType, title[2]));

  if (path === "/api/items" && method === "GET") return json(await listItems(env, userId));

  const item = path.match(/^\/api\/items\/([^/]+)$/);
  if (item) {
    const key = decodeURIComponent(item[1]);
    if (!KEY_RE.test(key)) return fail(400, "Invalid item key.");
    if (method === "PUT") return putItem(req, env, userId, key);
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM user_items WHERE user_id = ? AND key = ?").bind(userId, key).run();
      return json({ ok: true });
    }
  }

  return fail(404, "Not found.");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof TmdbError) return fail(e.status, e.message);
      console.error(e);
      return fail(500, "Something went wrong on the server.");
    }
  },
};
