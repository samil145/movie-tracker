export type MediaType = "movie" | "tv";
export type Status = "watchlist" | "watched";

export interface Hit {
  type: MediaType;
  id: number;
  title: string;
  year: number | null;
  poster: string | null;
  overview: string;
}

export interface Details extends Hit {
  originalTitle: string | null;
  endYear: number | null;
  runtime: number | null;
  seasons: number | null;
  episodes: number | null;
  ongoing: boolean;
  backdrop: string | null;
  genres: string[];
  keywords: string[];
  tagline: string | null;
  rating: number | null;
  directors: string[];
  cast: { name: string; character: string | null; photo: string | null }[];
  trailer: string | null;
}

/** What we keep in the library — a small snapshot so lists render without hitting TMDB. */
export interface Item {
  key: string;
  type: MediaType;
  id: number;
  title: string;
  year: number | null;
  runtime: number | null;
  seasons: number | null;
  episodes: number | null;
  poster: string | null;
  genres: string[];
  category: CategoryId;
  status: Status;
  favorite: boolean;
  addedAt: number;
  watchedAt: number | null;
  /** Your own score, 0.5–5 in half steps. Optional: rows saved before ratings existed don't have it. */
  myRating?: number | null;
  note?: string;
}

export const VERDICTS: Record<number, string> = {
  0.5: "Unwatchable",
  1: "Bad",
  1.5: "Weak",
  2: "Meh",
  2.5: "Okay",
  3: "Good",
  3.5: "Really good",
  4: "Great",
  4.5: "Loved it",
  5: "Masterpiece",
};

export const formatRating = (r: number) => (Number.isInteger(r) ? String(r) : r.toFixed(1));

export const keyOf = (t: { type: MediaType; id: number }) => `${t.type}:${t.id}`;

/* ---------- categories ---------- */

export const CATEGORIES = [
  { id: "action", label: "Action & Adrenaline" },
  { id: "romance", label: "Romance" },
  { id: "war", label: "War" },
  { id: "mind", label: "Mind & Philosophy" },
  { id: "crime", label: "Crime & Thriller" },
  { id: "scifi", label: "Sci-Fi & Fantasy" },
  { id: "comedy", label: "Comedy" },
  { id: "horror", label: "Horror" },
  { id: "drama", label: "Drama" },
  { id: "animation", label: "Animation & Family" },
  { id: "documentary", label: "Documentary" },
  { id: "other", label: "Everything else" },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]["id"];

export const categoryLabel = (id: CategoryId) => CATEGORIES.find((c) => c.id === id)?.label ?? "Everything else";

const GENRE_MAP: Record<string, CategoryId> = {
  action: "action",
  adventure: "action",
  western: "action",
  "action & adventure": "action",
  romance: "romance",
  "science fiction": "scifi",
  fantasy: "scifi",
  "sci-fi & fantasy": "scifi",
  crime: "crime",
  thriller: "crime",
  mystery: "crime",
  comedy: "comedy",
  family: "animation",
  kids: "animation",
};

// TMDB has no "philosophical" genre, so that shelf is driven by its keywords instead.
const MIND = /philosoph(y|ical)|existential|meaning of life|nihilis|metaphysic|consciousness|free will|surreal|simulated reality|nature of reality|thought-provoking|meditative|human nature|morality/i;

/** Pick one default shelf for a title. The user can always move it by hand. */
export function categorize(genres: string[], keywords: string[]): CategoryId {
  const g = genres.map((x) => x.toLowerCase());
  const has = (name: string) => g.includes(name);

  if (has("documentary")) return "documentary";
  if (has("animation")) return "animation";
  if (keywords.some((k) => MIND.test(k))) return "mind";
  if (has("war") || has("war & politics")) return "war";
  if (has("horror")) return "horror";
  // A love story usually lists Drama first; don't let that (or Comedy) bury it.
  if (g.slice(0, 3).includes("romance") && !g.some((x) => ["action", "crime", "thriller", "science fiction"].includes(x))) {
    return "romance";
  }
  // Comedy is often listed first on films that are really thrillers or action (Parasite, Hot Fuzz),
  // so it only wins when nothing stronger is present.
  for (const name of g) {
    const hit = GENRE_MAP[name];
    if (hit && hit !== "comedy") return hit;
  }
  if (has("comedy")) return "comedy";
  if (g.some((x) => ["drama", "history", "music", "soap"].includes(x))) return "drama";
  return "other";
}

export function makeItem(d: Details, status: Status, favorite = false): Item {
  const now = Date.now();
  return {
    key: keyOf(d),
    type: d.type,
    id: d.id,
    title: d.title,
    year: d.year,
    runtime: d.runtime,
    seasons: d.seasons,
    episodes: d.episodes,
    poster: d.poster,
    genres: d.genres,
    category: categorize(d.genres, d.keywords),
    status,
    favorite,
    addedAt: now,
    watchedAt: status === "watched" ? now : null,
  };
}

/* ---------- formatting ---------- */

export function formatMinutes(min: number | null | undefined): string | null {
  if (!min || min <= 0) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** "1h 45m" for a film, "3 seasons" for a series. */
export function duration(t: Pick<Item, "type" | "runtime" | "seasons">): string | null {
  if (t.type === "movie") return formatMinutes(t.runtime);
  if (t.seasons) return `${t.seasons} season${t.seasons === 1 ? "" : "s"}`;
  return null;
}

export const img = (path: string | null, size: "w185" | "w342" | "w500" | "w780" | "w1280" | "w180_and_h180_face") =>
  path ? `https://image.tmdb.org/t/p/${size}${path}` : null;

/* ---------- API ---------- */

export interface User {
  id: string;
  email: string;
  username: string;
  hasPassword: boolean;
  google: boolean;
  avatar: string | null;
  createdAt: number;
}

/** The same rules the server enforces; the sign-up screen ticks them off as you type. */
export const PASSWORD_RULES: { label: string; test: (p: string) => boolean }[] = [
  { label: "At least 8 characters", test: (p) => p.length >= 8 },
  { label: "An uppercase letter", test: (p) => /[A-Z]/.test(p) },
  { label: "A lowercase letter", test: (p) => /[a-z]/.test(p) },
  { label: "A number", test: (p) => /\d/.test(p) },
];
export const passwordOk = (p: string) => PASSWORD_RULES.every((r) => r.test(p));
export const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Extra fields the server sent with the error (which field was wrong, a local test link, …). */
    public data: Record<string, any> = {},
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", ...init });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "You seem to be offline.");
  }
  const body = (await res.json().catch(() => null)) as any;
  // A 401 from anything but the auth screens means the session ended: send the app back to sign-in.
  if (res.status === 401 && !path.startsWith("/api/auth/")) window.dispatchEvent(new Event("mt:signed-out"));
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`, body ?? {});
  return body as T;
}

const post = <T>(path: string, body?: unknown, method = "POST") =>
  call<T>(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

type Authed = { user: User };
type Sent = { ok: true; email?: string; devLink?: string | null };

export const auth = {
  state: () => call<{ user: User | null; google: boolean }>("/api/auth/state"),
  usernameFree: (username: string, signal?: AbortSignal) =>
    call<{ available: boolean }>(`/api/auth/check?username=${encodeURIComponent(username)}`, { signal }),
  signup: (email: string, username: string, password: string) => post<Sent>("/api/auth/signup", { email, username, password }),
  resend: (email: string) => post<Sent>("/api/auth/resend", { email }),
  verify: (token: string) => post<Authed>("/api/auth/verify", { token }),
  login: (identifier: string, password: string) => post<Authed>("/api/auth/login", { identifier, password }),
  forgot: (email: string) => post<Sent>("/api/auth/forgot", { email }),
  reset: (token: string, password: string) => post<Authed>("/api/auth/reset", { token, password }),
  logout: () => post<{ ok: true }>("/api/auth/logout"),
  logoutEverywhere: () => post<{ ok: true }>("/api/me/sessions", undefined, "DELETE"),
  rename: (username: string) => post<Authed>("/api/me", { username }, "PATCH"),
  setPassword: (current: string, password: string) => post<Authed>("/api/me/password", { current, password }),
  deleteAccount: (confirm: string) => post<{ ok: true }>("/api/me", { confirm }, "DELETE"),
};

export const api = {
  search: (q: string, signal?: AbortSignal) => call<Hit[]>(`/api/search?q=${encodeURIComponent(q)}`, { signal }),
  trending: () => call<Hit[]>("/api/trending"),
  details: (type: MediaType, id: number, signal?: AbortSignal) => call<Details>(`/api/title/${type}/${id}`, { signal }),
  items: () => call<Item[]>("/api/items"),
  put: (item: Item) =>
    call<{ ok: true }>(`/api/items/${encodeURIComponent(item.key)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(item),
    }),
  remove: (key: string) => call<{ ok: true }>(`/api/items/${encodeURIComponent(key)}`, { method: "DELETE" }),
};
