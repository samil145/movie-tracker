import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  api,
  auth,
  CATEGORIES,
  categoryLabel,
  duration,
  formatMinutes,
  keyOf,
  type Hit,
  type Item,
  type MediaType,
  type Status,
  type User,
} from "./lib";
import { Card, Empty, HitCard, Icon, LibContext, Logo, Row, typeLabel, useLib, type Lib } from "./ui";
import { Detail, type Seed } from "./Detail";
import { Import } from "./Import";
import { Auth, linkFromHash } from "./Auth";
import { Avatar, Profile } from "./Profile";

/* ---------- tiny hash router (so the back gesture closes a title) ---------- */

type Tab = "home" | "watchlist" | "watched" | "favorites" | "profile";
interface Route {
  tab: Tab;
  detail: { type: MediaType; id: number } | null;
}

function parseRoute(): Route {
  const m = location.hash.match(/^#\/(home|watchlist|watched|favorites|profile)(?:\/(movie|tv)\/(\d+))?/);
  if (!m) return { tab: "home", detail: null };
  return { tab: m[1] as Tab, detail: m[2] ? { type: m[2] as MediaType, id: Number(m[3]) } : null };
}

function useRoute() {
  const [route, setRoute] = useState(parseRoute);
  useEffect(() => {
    const sync = () => setRoute(parseRoute());
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);
  const go = useCallback((hash: string, mode: "push" | "replace" = "push") => {
    if (mode === "push") history.pushState({ reel: true }, "", hash);
    else history.replaceState(null, "", hash);
    setRoute(parseRoute());
  }, []);
  return [route, go] as const;
}

/**
 * Run a navigation inside a view transition so the poster morphs between the list and the title sheet.
 * `from` is the poster leaving; `to` finds the poster it should land on once the new screen is rendered.
 * Falls back to a plain update where the browser has no view transitions or the user asked for less motion.
 */
function morph(update: () => void | Promise<void>, from?: HTMLElement | null, to?: () => HTMLElement | null) {
  const doc = document as Document & { startViewTransition?: (cb: () => void | Promise<void>) => { finished: Promise<void> } };
  if (!doc.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) return void update();
  if (from) from.style.viewTransitionName = "poster";
  let landed: HTMLElement | null = null;
  doc
    .startViewTransition(async () => {
      await update();
      if (from) from.style.viewTransitionName = "";
      landed = to?.() ?? null;
      if (landed) landed.style.viewTransitionName = "poster";
    })
    .finished.catch(() => {})
    .finally(() => {
      if (from) from.style.viewTransitionName = "";
      if (landed) landed.style.viewTransitionName = "";
    });
}

const TABS: { id: Tab; label: string; icon: "home" | "bookmark" | "check" | "heart" }[] = [
  { id: "home", label: "Home", icon: "home" },
  { id: "watchlist", label: "Watchlist", icon: "bookmark" },
  { id: "watched", label: "Watched", icon: "check" },
  { id: "favorites", label: "Favourites", icon: "heart" },
];

/* ---------- library state: instant from cache, then synced with the server ---------- */

// Each account caches its own list, so switching accounts on one device never shows the wrong one.
const cacheKey = (userId: string) => `mt:items:${userId}`;

function readCache(userId: string): Record<string, Item> {
  try {
    return JSON.parse(localStorage.getItem(cacheKey(userId)) ?? "{}");
  } catch {
    return {};
  }
}

interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

/* ---------- app ---------- */

export function App() {
  // undefined = still asking the server who this is; null = signed out.
  const [me, setMe] = useState<User | null | undefined>(undefined);
  const [google, setGoogle] = useState(false);
  const [offline, setOffline] = useState(false);
  const [, setLinkSeen] = useState(0);

  const load = useCallback(() => {
    setOffline(false);
    auth
      .state()
      .then((s) => {
        setGoogle(s.google);
        setMe(s.user);
      })
      .catch(() => setOffline(true));
  }, []);

  useEffect(() => {
    load();
    const out = () => setMe(null);
    // Re-render on hash changes so an emailed link opened in an already-open tab is noticed.
    const onHash = () => linkFromHash() && setLinkSeen((n) => n + 1);
    window.addEventListener("mt:signed-out", out);
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("mt:signed-out", out);
      window.removeEventListener("hashchange", onHash);
    };
  }, [load]);

  if (offline) {
    return (
      <div className="boot">
        <Empty title="Can't reach Movie Tracker">Check your connection and try again.</Empty>
        <button className="btn primary" onClick={load}>
          Try again
        </button>
      </div>
    );
  }
  if (me === undefined) return <div className="boot" aria-busy="true" />;
  // An emailed confirm or reset link always opens its own screen, even if this device is signed in as someone.
  if (me === null || linkFromHash()) return <Auth google={google} onAuthed={setMe} />;
  return <Shell key={me.id} me={me} onUser={setMe} onSignedOut={() => setMe(null)} />;
}

function Shell({ me, onUser, onSignedOut }: { me: User; onUser: (u: User) => void; onSignedOut: () => void }) {
  const [route, go] = useRoute();
  const [items, setItems] = useState<Record<string, Item>>(() => readCache(me.id));
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seeds = useRef(new Map<string, Seed>());
  const searchRef = useRef<HTMLInputElement>(null);

  const toast = useCallback<Lib["toast"]>((text, action) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 6000 : 2600);
  }, []);

  const refresh = useCallback(() => {
    api
      .items()
      .then((list) => setItems(Object.fromEntries(list.map((i) => [i.key, i]))))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  useEffect(() => {
    try {
      localStorage.setItem(cacheKey(me.id), JSON.stringify(items));
    } catch {
      /* private mode / full storage: the server copy is still the source of truth */
    }
  }, [items, me.id]);

  const save = useCallback<Lib["save"]>(
    (item) => {
      setItems((prev) => ({ ...prev, [item.key]: item }));
      api.put(item).catch((e) => {
        toast(`Couldn't save “${item.title}” — ${e.message}`);
        refresh();
      });
    },
    [toast, refresh],
  );

  const remove = useCallback<Lib["remove"]>(
    (key) => {
      setItems((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      api.remove(key).catch((e) => {
        toast(`Couldn't remove it — ${e.message}`);
        refresh();
      });
    },
    [toast, refresh],
  );

  const open = useCallback<Lib["open"]>(
    (t, from) => {
      seeds.current.set(keyOf(t), { title: t.title, year: t.year, poster: t.poster });
      const hash = `#/${parseRoute().tab}/${t.type}/${t.id}`;
      morph(() => flushSync(() => go(hash)), from?.querySelector<HTMLElement>(".poster"));
    },
    [go],
  );

  const closeDetail = useCallback(() => {
    const { tab, detail } = parseRoute();
    const key = detail ? keyOf(detail) : "";
    morph(
      async () => {
        if (history.state?.reel) {
          // history.back() is asynchronous: wait for it, then let React paint the list before the snapshot.
          const popped = new Promise((done) => window.addEventListener("popstate", done, { once: true }));
          history.back();
          await popped;
          flushSync(() => {});
        } else {
          flushSync(() => go(`#/${tab}`, "replace"));
        }
      },
      null,
      () => document.querySelector<HTMLElement>(`.main [data-key="${key}"] .poster`),
    );
  }, [go]);

  const lib = useMemo<Lib>(() => ({ items, save, remove, open, toast }), [items, save, remove, open, toast]);

  // "/" jumps to search, like most apps with a search box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const selectTab = (tab: Tab) => {
    setQuery("");
    go(`#/${tab}`, "replace");
    window.scrollTo({ top: 0 });
  };

  const all = useMemo(() => Object.values(items), [items]);
  const counts = {
    home: 0,
    profile: 0,
    watchlist: all.filter((i) => i.status === "watchlist").length,
    watched: all.filter((i) => i.status === "watched").length,
    favorites: all.filter((i) => i.favorite).length,
  };

  const searching = query.trim().length > 0;

  return (
    <LibContext.Provider value={lib}>
      <div className="app">
        <nav className="nav" aria-label="Main">
          <button className="brand-btn" onClick={() => selectTab("home")} aria-label="Movie Tracker home">
            <Logo size={38} word />
          </button>
          <ul>
            {TABS.map((t) => (
              <li key={t.id}>
                <button
                  className={route.tab === t.id && !searching ? "active" : ""}
                  aria-current={route.tab === t.id && !searching ? "page" : undefined}
                  onClick={() => selectTab(t.id)}
                >
                  <Icon name={t.icon} filled={route.tab === t.id && !searching && t.icon !== "check"} />
                  <span>{t.label}</span>
                  {t.id !== "home" && counts[t.id] > 0 && <em>{counts[t.id]}</em>}
                </button>
              </li>
            ))}
          </ul>
          <div className="nav-foot">
            <button className={`me ${route.tab === "profile" && !searching ? "active" : ""}`} onClick={() => selectTab("profile")}>
              <Avatar user={me} size={30} /> <span>{me.username}</span>
            </button>
            <button onClick={() => setImporting(true)}>
              <Icon name="list" size={18} /> Import a list
            </button>
          </div>
        </nav>

        <div className="main">
          <header className="topbar">
            <Logo size={40} />
            <label className="search">
              <Icon name="search" size={18} />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search movies and series"
                aria-label="Search movies and series"
                enterKeyHint="search"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
              {searching && (
                <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
                  <Icon name="close" size={16} />
                </button>
              )}
            </label>
            <button className="topbar-me" onClick={() => selectTab("profile")} aria-label="Your profile">
              <Avatar user={me} size={38} />
            </button>
          </header>

          <main className="content" key={searching ? "search" : route.tab}>
            {searching ? (
              <SearchResults query={query.trim()} />
            ) : route.tab === "home" ? (
              <Home all={all} onImport={() => setImporting(true)} />
            ) : route.tab === "profile" ? (
              <Profile user={me} all={all} onUser={onUser} onSignedOut={onSignedOut} onImport={() => setImporting(true)} />
            ) : route.tab === "favorites" ? (
              <Favorites all={all} />
            ) : (
              <Shelves key={route.tab} all={all} status={route.tab} />
            )}
          </main>
        </div>

        {route.detail && (
          <Detail
            type={route.detail.type}
            id={route.detail.id}
            seed={seeds.current.get(keyOf(route.detail))}
            onClose={closeDetail}
          />
        )}
        {importing && <Import onClose={() => setImporting(false)} />}

        <div className="toasts" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className="toast">
              <span>{t.text}</span>
              {t.action && (
                <button
                  onClick={() => {
                    t.action!.run();
                    setToasts((list) => list.filter((x) => x.id !== t.id));
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </LibContext.Provider>
  );
}

/* ---------- search ---------- */

function SearchResults({ query }: { query: string }) {
  const { items, open } = useLib();
  const [state, setState] = useState<{ q: string; hits: Hit[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      api
        .search(query, ctrl.signal)
        .then((hits) => {
          setState({ q: query, hits });
          setError(null);
        })
        .catch((e) => {
          if (e.name !== "AbortError") setError(e.message);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  if (error) return <Empty title="Search didn't work">{error}</Empty>;
  if (!state) return <ul className="rows skeleton-rows" aria-busy="true">{[0, 1, 2, 3, 4].map((i) => <li key={i} />)}</ul>;
  if (!state.hits.length) return <Empty title={`Nothing found for “${state.q}”`}>Check the spelling, or try the original-language title.</Empty>;

  return (
    <ul className={`rows ${state.q !== query ? "stale" : ""}`}>
      {state.hits.map((h) => {
        const saved = items[keyOf(h)];
        return (
          <Row
            key={keyOf(h)}
            dataKey={keyOf(h)}
            title={h.title}
            poster={h.poster}
            onOpen={(el) => open(h, el)}
            sub={
              <>
                {typeLabel(h.type)}
                {h.year ? ` · ${h.year}` : ""}
                {saved && <b className="tag">{saved.status === "watched" ? "Watched" : "On watchlist"}</b>}
              </>
            }
          />
        );
      })}
    </ul>
  );
}

/* ---------- home ---------- */

type Sort = "recent" | "short" | "long" | "az";

function Home({ all, onImport }: { all: Item[]; onImport: () => void }) {
  const { open, save, toast } = useLib();
  const [sort, setSort] = useState<Sort>("recent");
  const [trending, setTrending] = useState<Hit[]>([]);

  useEffect(() => {
    api.trending().then(setTrending).catch(() => {});
  }, []);

  const queue = useMemo(() => {
    const list = all.filter((i) => i.status === "watchlist");
    const rt = (i: Item, missing: number) => (i.type === "movie" && i.runtime ? i.runtime : missing);
    if (sort === "recent") list.sort((a, b) => b.addedAt - a.addedAt);
    if (sort === "short") list.sort((a, b) => rt(a, Infinity) - rt(b, Infinity));
    if (sort === "long") list.sort((a, b) => rt(b, -1) - rt(a, -1));
    if (sort === "az") list.sort((a, b) => a.title.localeCompare(b.title));
    return list;
  }, [all, sort]);

  const minutes = queue.reduce((sum, i) => sum + (i.type === "movie" ? (i.runtime ?? 0) : 0), 0);
  const watched = all.length - queue.length;

  const markWatched = (item: Item) => {
    save({ ...item, status: "watched", watchedAt: Date.now() });
    open(item); // straight to the title so it can be rated while it's fresh
    toast(`Watched “${item.title}”`, { label: "Undo", run: () => save(item) });
  };

  return (
    <>
      {all.length === 0 ? (
        <section className="welcome">
          <h1>Nothing saved yet.</h1>
          <p>Search for a title above, or paste the list from your Notes and add everything in one go.</p>
          <button className="btn primary" onClick={onImport}>
            <Icon name="list" size={18} /> Import a list
          </button>
        </section>
      ) : (
        <section>
          <dl className="stats">
            <div>
              <dt>To watch</dt>
              <dd>{queue.length}</dd>
            </div>
            <div>
              <dt>Film time</dt>
              <dd>{formatMinutes(minutes) ?? "—"}</dd>
            </div>
            <div>
              <dt>Watched</dt>
              <dd>{watched}</dd>
            </div>
          </dl>

          <div className="section-head">
            <h2>Up next</h2>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
              <option value="recent">Recently added</option>
              <option value="short">Shortest first</option>
              <option value="long">Longest first</option>
              <option value="az">A–Z</option>
            </select>
          </div>

          {queue.length === 0 ? (
            <Empty title="Your watchlist is empty">Everything you saved is watched. Search above to line up the next one.</Empty>
          ) : (
            <ul className="rows">
              {queue.map((item) => (
                <Row
                  key={item.key}
                  dataKey={item.key}
                  title={item.title}
                  poster={item.poster}
                  onOpen={(el) => open(item, el)}
                  sub={
                    <>
                      {item.year ?? ""}
                      {item.year ? " · " : ""}
                      {categoryLabel(item.category)}
                    </>
                  }
                  trailing={duration(item) ?? typeLabel(item.type)}
                  action={
                    <button className="row-check" onClick={() => markWatched(item)} aria-label={`Mark ${item.title} as watched`}>
                      <Icon name="check" size={18} />
                    </button>
                  }
                />
              ))}
            </ul>
          )}
        </section>
      )}

      {trending.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Trending this week</h2>
          </div>
          <div className="rail">
            {trending.map((h) => (
              <HitCard key={keyOf(h)} hit={h} />
            ))}
          </div>
        </section>
      )}

      {all.length > 0 && (
        <div className="mobile-foot">
          <button className="link" onClick={onImport}>
            Import a list
          </button>
        </div>
      )}
    </>
  );
}

/* ---------- watchlist / watched, shelved by category ---------- */

type Kind = "all" | MediaType;

function KindFilter({ value, onChange }: { value: Kind; onChange: (k: Kind) => void }) {
  const options: [Kind, string][] = [
    ["all", "All"],
    ["movie", "Movies"],
    ["tv", "Series"],
  ];
  return (
    <div className="segmented" role="group" aria-label="Filter by type">
      {options.map(([k, label]) => (
        <button key={k} className={value === k ? "active" : ""} aria-pressed={value === k} onClick={() => onChange(k)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Shelves({ all, status }: { all: Item[]; status: Status }) {
  const [kind, setKind] = useState<Kind>("all");

  const list = all.filter((i) => i.status === status);
  const shown = list.filter((i) => kind === "all" || i.type === kind);
  const when = (i: Item) => (status === "watched" ? (i.watchedAt ?? i.addedAt) : i.addedAt);

  const shelves = CATEGORIES.map((c) => ({
    ...c,
    items: shown.filter((i) => i.category === c.id).sort((a, b) => when(b) - when(a)),
  })).filter((s) => s.items.length > 0);

  return (
    <>
      <div className="page-head">
        <h1>{status === "watchlist" ? "Watchlist" : "Watched"}</h1>
        <KindFilter value={kind} onChange={setKind} />
      </div>

      {list.length === 0 ? (
        <Empty title={status === "watchlist" ? "Nothing on your watchlist" : "Nothing watched yet"}>
          {status === "watchlist"
            ? "Search for a title and add it — it will be sorted onto a shelf automatically."
            : "Mark a title as watched and it moves here."}
        </Empty>
      ) : shelves.length === 0 ? (
        <Empty title={kind === "movie" ? "No movies here" : "No series here"} />
      ) : (
        shelves.map((s) => (
          <section key={s.id} className="shelf">
            <div className="section-head">
              <h2>{s.label}</h2>
              <span className="count">{s.items.length}</span>
            </div>
            <div className="grid">
              {s.items.map((i) => (
                <Card key={i.key} item={i} />
              ))}
            </div>
          </section>
        ))
      )}
    </>
  );
}

function Favorites({ all }: { all: Item[] }) {
  const list = all.filter((i) => i.favorite).sort((a, b) => b.addedAt - a.addedAt);
  return (
    <>
      <div className="page-head">
        <h1>Favourites</h1>
      </div>
      {list.length === 0 ? (
        <Empty title="No favourites yet">Tap the heart on any title to keep it here.</Empty>
      ) : (
        <div className="grid">
          {list.map((i) => (
            <Card key={i.key} item={i} />
          ))}
        </div>
      )}
    </>
  );
}
