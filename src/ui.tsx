import { createContext, useContext, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { duration, formatRating, img, type Hit, type Item, type MediaType } from "./lib";

/* ---------- shared app context ---------- */

export interface Lib {
  items: Record<string, Item>;
  save: (item: Item) => void;
  remove: (key: string) => void;
  /** Pass the element that was tapped and its poster flies into the title sheet. */
  open: (
    t: { type: MediaType; id: number; title: string; year: number | null; poster: string | null },
    from?: Element | null,
  ) => void;
  toast: (text: string, action?: { label: string; run: () => void }) => void;
}

export const LibContext = createContext<Lib | null>(null);
export function useLib(): Lib {
  const lib = useContext(LibContext);
  if (!lib) throw new Error("LibContext missing");
  return lib;
}

/* ---------- icons ---------- */

const PATHS = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  bookmark: "M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1z",
  check: "m4.5 12.5 5 5 10-11",
  heart: "M12 20.5S3.5 15.4 3.5 9.2A4.7 4.7 0 0 1 12 6.6a4.7 4.7 0 0 1 8.5 2.6c0 6.2-8.5 11.3-8.5 11.3z",
  search: "M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13zm5-1.5L21 21",
  close: "M6 6l12 12M18 6 6 18",
  back: "M15 5l-7 7 7 7",
  plus: "M12 5v14M5 12h14",
  play: "M8 5.5v13l11-6.5z",
  star: "m12 3 2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 16.9 6.6 19.8l1.1-6.1L3.2 9.4l6.1-.8z",
  list: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01",
  trash: "M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeOff: "M3 3l18 18M10.6 5.1A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3 3.9M6.5 6.6A17.3 17.3 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 4.4-1",
  mail: "M3 6h18v12H3zM3 7l9 7 9-7",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-8 9a8 8 0 0 1 16 0",
  logout: "M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M15 8l4 4-4 4M19 12H9",
  undo: "M9 7 4 12l5 5M4 12h10a6 6 0 0 1 0 12",
} as const;

export function Icon({ name, filled, size = 20 }: { name: keyof typeof PATHS; filled?: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/* ---------- logo ---------- */

export function Logo({ size = 34, word = false }: { size?: number; word?: boolean }) {
  return (
    <span className="brand">
      <span className="mark" style={{ width: size, height: size }}>
        <LogoArt />
      </span>
      {word && (
        <span className="word">
          Movie <b>Tracker</b>
        </span>
      )}
    </span>
  );
}

/** Film frame (sprocket holes down both edges) with a play triangle. Drawn on the 512 grid used by public/icon.svg. */
function LogoArt() {
  return (
    <svg viewBox="0 0 512 512" aria-hidden="true">
      <g fill="#1c0612" fillOpacity="0.42">
        {[84, 228, 372].map((y) => (
          <g key={y}>
            <rect x="52" y={y} width="50" height="56" rx="13" />
            <rect x="410" y={y} width="50" height="56" rx="13" />
          </g>
        ))}
      </g>
      <path d="M190 164v184l150-92z" fill="#fff" stroke="#fff" strokeWidth="34" strokeLinejoin="round" />
    </svg>
  );
}

/* ---------- star rating: tap or slide across, half-star steps ---------- */

const STAR = "m12 2.6 2.9 6 6.5.9-4.7 4.6 1.1 6.5L12 17.5l-5.8 3.1 1.1-6.5L2.6 9.5l6.5-.9z";

function StarRow({ fill }: { fill: string }) {
  return (
    <>
      {[0, 1, 2, 3, 4].map((i) => (
        <svg key={i} viewBox="0 0 24 24" aria-hidden="true">
          <path d={STAR} fill={fill} />
        </svg>
      ))}
    </>
  );
}

export function StarRating({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? value ?? 0;

  const at = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.min(5, Math.max(0.5, Math.ceil(((e.clientX - r.left) / r.width) * 10) / 2));
  };

  const onKey = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowUp" ? 0.5 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -0.5 : 0;
    if (!step) return;
    e.preventDefault();
    const next = Math.min(5, Math.max(0, (value ?? 0) + step));
    onChange(next === 0 ? null : next);
  };

  return (
    <div
      ref={ref}
      className={`stars ${drag !== null ? "dragging" : ""}`}
      role="slider"
      tabIndex={0}
      aria-label="Your rating"
      aria-valuemin={0}
      aria-valuemax={5}
      aria-valuenow={value ?? 0}
      aria-valuetext={value ? `${formatRating(value)} out of 5` : "Not rated"}
      onKeyDown={onKey}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(at(e));
      }}
      onPointerMove={(e) => drag !== null && setDrag(at(e))}
      onPointerUp={(e) => {
        if (drag === null) return;
        const v = at(e);
        setDrag(null);
        onChange(v === value ? null : v); // tapping your current score clears it
      }}
      onPointerCancel={() => setDrag(null)}
    >
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <linearGradient id="star-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffd84d" />
          <stop offset="1" stopColor="#ff8a3d" />
        </linearGradient>
      </svg>
      <div className="stars-row base">
        <StarRow fill="currentColor" />
      </div>
      <div className="stars-clip" style={{ width: `${(shown / 5) * 100}%` }}>
        <div className="stars-row">
          <StarRow fill="url(#star-grad)" />
        </div>
      </div>
    </div>
  );
}

/* ---------- poster ---------- */

export function Poster({ path, title, size = "w342" }: { path: string | null; title: string; size?: "w185" | "w342" | "w500" }) {
  const src = img(path, size);
  return (
    <div className="poster">
      {src ? (
        <img src={src} alt="" loading="lazy" decoding="async" onLoad={(e) => e.currentTarget.classList.add("in")} />
      ) : (
        <span className="poster-fallback">{title}</span>
      )}
    </div>
  );
}

const typeLabel = (t: MediaType) => (t === "movie" ? "Movie" : "Series");

/* ---------- grid card (shelves) ---------- */

export function Card({ item }: { item: Item }) {
  const { open } = useLib();
  return (
    <button className="card" data-key={item.key} onClick={(e) => open(item, e.currentTarget)}>
      <Poster path={item.poster} title={item.title} />
      {item.favorite && (
        <span className="card-fav" aria-label="Favourite">
          <Icon name="heart" filled size={13} />
        </span>
      )}
      <span className="card-title">{item.title}</span>
      <span className="card-meta">
        {item.myRating ? (
          <b className="my-score">
            <Icon name="star" filled size={11} /> {formatRating(item.myRating)}
          </b>
        ) : null}
        {duration(item) ?? item.year ?? typeLabel(item.type)}
      </span>
    </button>
  );
}

export function HitCard({ hit }: { hit: Hit }) {
  const { open } = useLib();
  return (
    <button className="card" data-key={`${hit.type}:${hit.id}`} onClick={(e) => open(hit, e.currentTarget)}>
      <Poster path={hit.poster} title={hit.title} />
      <span className="card-title">{hit.title}</span>
      <span className="card-meta">
        {typeLabel(hit.type)}
        {hit.year ? ` · ${hit.year}` : ""}
      </span>
    </button>
  );
}

/* ---------- list row (home, search) ---------- */

export function Row({
  title,
  poster,
  sub,
  trailing,
  action,
  dataKey,
  onOpen,
}: {
  title: string;
  poster: string | null;
  sub: ReactNode;
  trailing?: ReactNode;
  action?: ReactNode;
  dataKey?: string;
  onOpen: (from: Element) => void;
}) {
  return (
    <li className="row">
      <button className="row-main" data-key={dataKey} onClick={(e) => onOpen(e.currentTarget)}>
        <Poster path={poster} title={title} size="w185" />
        <span className="row-text">
          <span className="row-title">{title}</span>
          <span className="row-sub">{sub}</span>
        </span>
        {trailing && <span className="row-trailing">{trailing}</span>}
      </button>
      {action}
    </li>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export { typeLabel };
