import { useEffect, useRef, useState } from "react";
import {
  api,
  CATEGORIES,
  formatMinutes,
  formatRating,
  VERDICTS,
  img,
  keyOf,
  makeItem,
  type CategoryId,
  type Details,
  type MediaType,
} from "./lib";
import { Icon, Poster, StarRating, useLib } from "./ui";

const cache = new Map<string, Details>();

export interface Seed {
  title: string;
  year: number | null;
  poster: string | null;
}

export function Detail({ type, id, seed, onClose }: { type: MediaType; id: number; seed?: Seed; onClose: () => void }) {
  const { items, save, remove, toast } = useLib();
  const key = keyOf({ type, id });
  const item = items[key];
  const [d, setD] = useState<Details | null>(() => cache.get(key) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [note, setNote] = useState(item?.note ?? "");
  const savedNote = item?.note ?? "";

  // Load the note when a different title opens — not on every save, or it would fight the typing.
  useEffect(() => {
    setNote(items[key]?.note ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Autosave shortly after typing stops.
  useEffect(() => {
    if (!item || note === savedNote) return;
    const t = setTimeout(() => save({ ...item, note }), 700);
    return () => clearTimeout(t);
  }, [note, savedNote, item, save]);

  useEffect(() => {
    setD(cache.get(key) ?? null);
    setError(null);
    setExpanded(false);
    const ctrl = new AbortController();
    api
      .details(type, id, ctrl.signal)
      .then((res) => {
        cache.set(key, res);
        setD(res);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => ctrl.abort();
  }, [key, type, id]);

  // Keep the saved snapshot fresh (new seasons, a runtime TMDB filled in later, a new poster).
  useEffect(() => {
    if (!d || !item) return;
    if (item.runtime !== d.runtime || item.seasons !== d.seasons || item.episodes !== d.episodes || item.poster !== d.poster) {
      save({ ...item, runtime: d.runtime, seasons: d.seasons, episodes: d.episodes, poster: d.poster });
    }
  }, [d, item, save]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.documentElement.classList.add("locked");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.documentElement.classList.remove("locked");
    };
  }, [onClose]);

  const title = d?.title ?? item?.title ?? seed?.title ?? "";
  const poster = d?.poster ?? item?.poster ?? seed?.poster ?? null;
  const year = d?.year ?? item?.year ?? seed?.year ?? null;
  const backdrop = img(d?.backdrop ?? null, "w1280");

  const meta: string[] = [];
  if (year) meta.push(d?.type === "tv" && d.endYear && d.endYear !== year ? `${year}–${d.endYear}` : d?.ongoing ? `${year}–now` : String(year));
  if (d) {
    if (d.type === "movie") {
      const rt = formatMinutes(d.runtime);
      if (rt) meta.push(rt);
    } else {
      if (d.seasons) meta.push(`${d.seasons} season${d.seasons === 1 ? "" : "s"}`);
      if (d.episodes) meta.push(`${d.episodes} episodes`);
      const rt = formatMinutes(d.runtime);
      if (rt) meta.push(`~${rt} each`);
    }
  }

  const add = (status: "watchlist" | "watched", favorite = false) => {
    if (!d) return;
    save(makeItem(d, status, favorite));
    toast(favorite ? "Added to favourites" : status === "watched" ? "Marked as watched" : "Added to watchlist");
  };

  const setStatus = (status: "watchlist" | "watched") => {
    if (!item) return;
    save({ ...item, status, watchedAt: status === "watched" ? Date.now() : null });
    toast(status === "watched" ? "Watched — how was it?" : "Moved back to watchlist");
  };

  const toggleFavorite = () => {
    if (item) save({ ...item, favorite: !item.favorite });
    else add("watchlist", true);
  };

  const onRemove = () => {
    if (!item) return;
    const snapshot = item;
    remove(item.key);
    toast("Removed from your library", { label: "Undo", run: () => save(snapshot) });
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <article className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <button ref={closeRef} className="sheet-close" onClick={onClose} aria-label="Close">
          <Icon name="close" />
        </button>

        <div key={backdrop ?? "none"} className={backdrop ? "hero loaded" : "hero"} style={backdrop ? { backgroundImage: `url(${backdrop})` } : undefined} />

        <div className="sheet-body">
          <header className="detail-head">
            <Poster path={poster} title={title} size="w342" />
            <div className="detail-titles">
              <span className="kicker">{type === "movie" ? "Movie" : "TV series"}</span>
              <h2>{title}</h2>
              {d?.originalTitle && <p className="original">{d.originalTitle}</p>}
              <p className="meta">
                {meta.map((m, i) => (
                  <span key={i}>{m}</span>
                ))}
                {d?.rating != null && (
                  <span className="rating">
                    <Icon name="star" filled size={13} /> {d.rating.toFixed(1)}
                  </span>
                )}
              </p>
            </div>
          </header>

          <div className="actions">
            {!item && (
              <>
                <button className="btn primary" disabled={!d} onClick={() => add("watchlist")}>
                  <Icon name="plus" size={18} /> Watchlist
                </button>
                <button className="btn" disabled={!d} onClick={() => add("watched")}>
                  <Icon name="check" size={18} /> Watched it
                </button>
              </>
            )}
            {item?.status === "watchlist" && (
              <button className="btn primary" onClick={() => setStatus("watched")}>
                <Icon name="check" size={18} /> Mark as watched
              </button>
            )}
            {item?.status === "watched" && (
              <button className="btn" onClick={() => setStatus("watchlist")}>
                <Icon name="undo" size={18} /> Back to watchlist
              </button>
            )}
            <button
              className={`btn icon ${item?.favorite ? "on" : ""}`}
              disabled={!d && !item}
              onClick={toggleFavorite}
              aria-pressed={Boolean(item?.favorite)}
              aria-label={item?.favorite ? "Remove from favourites" : "Add to favourites"}
            >
              <Icon name="heart" filled={Boolean(item?.favorite)} />
            </button>
          </div>

          {item && (
            <p className="in-library">
              {item.status === "watched" ? "Watched" : "On your watchlist"}
              {item.status === "watched" && item.watchedAt
                ? ` · ${new Date(item.watchedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`
                : ""}
            </p>
          )}

          {item?.status === "watched" && (
            <section className="mytake">
              <div className="mytake-head">
                <h3 className="label">Your rating</h3>
                {item.myRating ? (
                  <p className="verdict" key={item.myRating}>
                    <b>{VERDICTS[item.myRating]}</b>
                    <span>{formatRating(item.myRating)} / 5</span>
                  </p>
                ) : (
                  <p className="verdict unrated">Tap or slide to rate</p>
                )}
              </div>
              <StarRating value={item.myRating ?? null} onChange={(v) => save({ ...item, myRating: v })} />
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, 2000))}
                onBlur={() => note !== savedNote && save({ ...item, note })}
                placeholder="Notes (optional) — what stuck with you?"
                aria-label="Your notes"
                rows={3}
              />
            </section>
          )}

          {error && <p className="error">{error}</p>}

          {!d && !error && (
            <div className="skeleton-block" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
          )}

          {d && (
            <>
              {d.genres.length > 0 && (
                <ul className="chips">
                  {d.genres.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              )}

              {d.tagline && <p className="tagline">{d.tagline}</p>}

              {d.overview ? (
                <div className="overview">
                  <p className={expanded ? "" : "clamp"}>{d.overview}</p>
                  {d.overview.length > 220 && (
                    <button className="link" onClick={() => setExpanded((v) => !v)}>
                      {expanded ? "Show less" : "Read more"}
                    </button>
                  )}
                </div>
              ) : (
                <p className="muted">No overview available.</p>
              )}

              <dl className="facts">
                {d.directors.length > 0 && (
                  <div>
                    <dt>{d.type === "movie" ? "Directed by" : "Created by"}</dt>
                    <dd>{d.directors.join(", ")}</dd>
                  </div>
                )}
                {d.trailer && (
                  <div>
                    <dt>Trailer</dt>
                    <dd>
                      <a className="link" href={d.trailer} target="_blank" rel="noreferrer">
                        <Icon name="play" filled size={13} /> Watch on YouTube
                      </a>
                    </dd>
                  </div>
                )}
              </dl>

              {d.cast.length > 0 && (
                <section>
                  <h3 className="label">Cast</h3>
                  <ul className="cast">
                    {d.cast.map((c) => {
                      // TMDB's "_face" sizes are square crops centred on the detected face, so heads aren't cut off in the circle.
                      const photo = img(c.photo, "w180_and_h180_face");
                      return (
                        <li key={c.name + c.character}>
                          <div className="avatar">
                            {photo ? <img src={photo} alt="" loading="lazy" /> : <span>{c.name.charAt(0)}</span>}
                          </div>
                          <span className="cast-name">{c.name}</span>
                          {c.character && <span className="cast-role">{c.character}</span>}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}
            </>
          )}

          {item && (
            <footer className="manage">
              <label>
                <span className="label">Shelf</span>
                <select value={item.category} onChange={(e) => save({ ...item, category: e.target.value as CategoryId })}>
                  {CATEGORIES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              <button className="btn danger" onClick={onRemove}>
                <Icon name="trash" size={17} /> Remove
              </button>
            </footer>
          )}
        </div>
      </article>
    </div>
  );
}
