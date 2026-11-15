import { useEffect, useState } from "react";
import { api, keyOf, makeItem, type Hit } from "./lib";
import { Icon, Poster, typeLabel, useLib } from "./ui";

interface Line {
  text: string;
  hits: Hit[];
  pick: number; // index into hits
  include: boolean;
}

/** Turn a pasted note into clean titles: drop bullets, numbering, checkboxes; pull out a "(2019)" hint. */
function parse(raw: string) {
  const seen = new Set<string>();
  const out: { text: string; year: number | null }[] = [];
  for (const line of raw.split(/\r?\n/)) {
    let text = line.replace(/^[\s\-–—*•·◦▪☐☑✓✔]+/, "").replace(/^\[[ xX]?\]\s*/, "").replace(/^\d{1,3}[.)]\s+/, "").trim();
    // Only a parenthesised year counts as a hint, so "Blade Runner 2049" and "1917" survive intact.
    const y = text.match(/\((19|20)\d{2}\)\s*$/);
    let year: number | null = null;
    if (y && text.length > y[0].length + 1) {
      year = Number(y[0].replace(/\D/g, ""));
      text = text.slice(0, y.index).trim();
    }
    if (text.length < 2 || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push({ text, year });
  }
  return out;
}

async function pool<T>(jobs: (() => Promise<T>)[], size: number, tick: () => void) {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, jobs.length) }, async () => {
      while (next < jobs.length) {
        const i = next++;
        results[i] = await jobs[i]();
        tick();
      }
    }),
  );
  return results;
}

export function Import({ onClose }: { onClose: () => void }) {
  const { items, save, toast } = useLib();
  const [raw, setRaw] = useState("");
  const [lines, setLines] = useState<Line[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.documentElement.classList.add("locked");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.documentElement.classList.remove("locked");
    };
  }, [onClose]);

  const parsed = parse(raw);

  const find = async () => {
    setBusy("Searching");
    setProgress(0);
    const found = await pool(
      parsed.map((p) => async (): Promise<Line> => {
        try {
          const hits = (await api.search(p.text)).slice(0, 5);
          const byYear = p.year ? hits.findIndex((h) => h.year === p.year) : -1;
          const pick = byYear >= 0 ? byYear : 0;
          return { text: p.text, hits, pick, include: hits.length > 0 && !items[keyOf(hits[pick])] };
        } catch {
          return { text: p.text, hits: [], pick: 0, include: false };
        }
      }),
      4,
      () => setProgress((n) => n + 1),
    );
    setLines(found);
    setBusy(null);
  };

  const chosen = (lines ?? []).filter((l) => l.include && l.hits[l.pick]);

  const addAll = async () => {
    setBusy("Adding");
    setProgress(0);
    let added = 0;
    await pool(
      chosen.map((l) => async () => {
        const hit = l.hits[l.pick];
        try {
          save(makeItem(await api.details(hit.type, hit.id), "watchlist"));
          added++;
        } catch {
          /* skip the ones that fail; they stay in the note */
        }
      }),
      4,
      () => setProgress((n) => n + 1),
    );
    toast(`Added ${added} title${added === 1 ? "" : "s"} to your watchlist`);
    onClose();
  };

  const update = (i: number, patch: Partial<Line>) =>
    setLines((prev) => prev && prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const total = lines ? chosen.length : parsed.length;

  return (
    <div className="sheet-backdrop" onClick={busy ? undefined : onClose}>
      <article className="sheet narrow" role="dialog" aria-modal="true" aria-label="Import a list" onClick={(e) => e.stopPropagation()}>
        <button className="sheet-close" onClick={onClose} aria-label="Close" disabled={Boolean(busy)}>
          <Icon name="close" />
        </button>
        <div className="sheet-body import">
          <h2>Import a list</h2>

          {!lines && (
            <>
              <p className="muted">Paste your note — one title per line. Add a year like “Crash (2004)” if a name is ambiguous.</p>
              <textarea
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                placeholder={"Interstellar\nThe Wire\nBefore Sunrise\n…"}
                rows={10}
                autoFocus
                spellCheck={false}
              />
              <button className="btn primary wide" disabled={!parsed.length || Boolean(busy)} onClick={find}>
                {busy ? `Searching… ${progress}/${parsed.length}` : parsed.length ? `Find ${parsed.length} title${parsed.length === 1 ? "" : "s"}` : "Find titles"}
              </button>
            </>
          )}

          {lines && (
            <>
              <p className="muted">Check the matches. Tap “Not this one” to cycle through other results.</p>
              <ul className="matches">
                {lines.map((l, i) => {
                  const hit = l.hits[l.pick];
                  const owned = hit && Boolean(items[keyOf(hit)]);
                  return (
                    <li key={l.text} className={l.include ? "" : "off"}>
                      {hit ? (
                        <>
                          <input
                            type="checkbox"
                            checked={l.include}
                            disabled={owned}
                            onChange={(e) => update(i, { include: e.target.checked })}
                            aria-label={`Include ${hit.title}`}
                          />
                          <Poster path={hit.poster} title={hit.title} size="w185" />
                          <div className="match-text">
                            <span className="row-title">{hit.title}</span>
                            <span className="row-sub">
                              {typeLabel(hit.type)}
                              {hit.year ? ` · ${hit.year}` : ""}
                              {owned ? " · already saved" : ""}
                            </span>
                            <span className="match-from">from “{l.text}”</span>
                          </div>
                          {l.hits.length > 1 && (
                            <button
                              className="link"
                              onClick={() => {
                                const pick = (l.pick + 1) % l.hits.length;
                                update(i, { pick, include: !items[keyOf(l.hits[pick])] });
                              }}
                            >
                              Not this one
                            </button>
                          )}
                        </>
                      ) : (
                        <div className="match-text">
                          <span className="row-title">{l.text}</span>
                          <span className="row-sub">No match found — try searching it by hand.</span>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              <div className="import-actions">
                <button className="btn" disabled={Boolean(busy)} onClick={() => setLines(null)}>
                  Back
                </button>
                <button className="btn primary" disabled={!total || Boolean(busy)} onClick={addAll}>
                  {busy ? `Adding… ${progress}/${chosen.length}` : `Add ${total} to watchlist`}
                </button>
              </div>
            </>
          )}
        </div>
      </article>
    </div>
  );
}
