import { ArrowsClockwise, Check, CircleNotch } from "@phosphor-icons/react";
import { KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { matchQuery } from "../util";

interface Props {
  value: string;
  /** Identifies the model list; a new key loads a new list. */
  cacheKey: string;
  fetch: () => Promise<string[]>;
  onCommit: (model: string) => void;
}

interface Option {
  id: string;
  ranges: [number, number][];
  custom?: boolean;
}

const MAX_OPTIONS = 300;
const lists = new Map<string, string[]>();

function Label({ text, ranges }: { text: string; ranges: [number, number][] }) {
  const cut = text.lastIndexOf("/") + 1;
  const marked = new Array<boolean>(text.length).fill(false);
  for (const [a, b] of ranges) for (let i = a; i < b; i++) marked[i] = true;
  const parts: { text: string; mark: boolean; dim: boolean }[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || marked[i] !== marked[start] || i === cut) {
      parts.push({ text: text.slice(start, i), mark: marked[start], dim: start < cut });
      start = i;
    }
  }
  return (
    <span className="combo-label">
      {parts.map((p, k) =>
        p.mark ? (
          <mark key={k} className={p.dim ? "dim" : undefined}>
            {p.text}
          </mark>
        ) : (
          <span key={k} className={p.dim ? "dim" : undefined}>
            {p.text}
          </span>
        ),
      )}
    </span>
  );
}

export function ModelField({ value, cacheKey, fetch, onCommit }: Props) {
  const [draft, setDraft] = useState(value);
  const [typed, setTyped] = useState(false);
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[] | null>(() => lists.get(cacheKey) ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const currentKey = useRef(cacheKey);
  const keepSelection = useRef(false);
  const listId = useId();

  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    currentKey.current = cacheKey;
    setModels(lists.get(cacheKey) ?? null);
    setError(null);
  }, [cacheKey]);

  const load = async (force: boolean) => {
    const key = cacheKey;
    if (!force && lists.has(key)) return setModels(lists.get(key)!);
    setLoading(true);
    setError(null);
    try {
      const ids = await fetch();
      lists.set(key, ids);
      if (currentKey.current === key) setModels(ids);
    } catch (e) {
      if (currentKey.current === key) setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const query = typed ? draft.trim() : "";
  const options = useMemo(() => {
    const all = models ?? [];
    let out: Option[];
    if (!query) out = all.map((id) => ({ id, ranges: [] }));
    else
      out = all
        .map((id) => ({ id, match: matchQuery(id, query) }))
        .filter((x) => x.match)
        .sort((a, b) => a.match!.score - b.match!.score)
        .map((x) => ({ id: x.id, ranges: x.match!.ranges }));
    out = out.slice(0, MAX_OPTIONS);
    if (query && !all.includes(query)) out.push({ id: query, ranges: [], custom: true });
    return out;
  }, [models, query]);
  const matches = options.filter((o) => !o.custom).length;

  useEffect(() => {
    if (open && !typed && models) setActive(Math.max(0, models.indexOf(value)));
  }, [models]);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open, options]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e.target !== input.current && !list.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const show = (selectCurrent: boolean) => {
    setRect(input.current!.getBoundingClientRect());
    setOpen(true);
    if (selectCurrent) setActive(Math.max(0, (models ?? []).indexOf(value)));
    if (!models && !loading && !error) load(false);
  };

  const commit = (text: string) => {
    const model = text.trim();
    setOpen(false);
    setTyped(false);
    setDraft(model);
    if (model !== value) onCommit(model);
  };

  const onKey = (e: KeyboardEvent) => {
    const n = options.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return show(true);
      if (n) setActive((a) => (a + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(open && options[active] ? options[active].id : draft);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
      setTyped(false);
      setDraft(value);
      requestAnimationFrame(() => input.current?.select());
    }
  };

  const below = rect ? window.innerHeight - rect.bottom - 12 : 0;
  const up = !!rect && below < 220 && rect.top > below;
  const position = rect
    ? {
        left: rect.left,
        width: Math.max(rect.width, 300),
        maxHeight: Math.min(340, up ? rect.top - 12 : below),
        ...(up ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
      }
    : undefined;

  return (
    <div className="combo">
      <input
        ref={input}
        className="field mono-field"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
        value={draft}
        placeholder="Search or type a model id"
        spellCheck={false}
        autoComplete="off"
        onFocus={(e) => {
          e.target.select();
          keepSelection.current = true;
          show(true);
        }}
        onMouseUp={(e) => {
          if (keepSelection.current) e.preventDefault();
          keepSelection.current = false;
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          setTyped(true);
          setActive(0);
          if (!open) show(false);
        }}
        onKeyDown={onKey}
        onBlur={() => commit(draft)}
      />
      <button
        className="icon-btn"
        title="Reload models from the provider"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          load(true);
          input.current?.focus();
        }}
      >
        <ArrowsClockwise size={13} className={loading ? "spin" : undefined} />
      </button>
      {open &&
        position &&
        createPortal(
          <div className="combo-list" id={listId} role="listbox" ref={list} style={position} onMouseDown={(e) => e.preventDefault()}>
            {loading && !models && (
              <div className="combo-note">
                <CircleNotch size={13} className="spin" /> Loading models…
              </div>
            )}
            {error && (
              <div className="combo-note error">
                <span>{error}</span>
                <button className="btn tiny" onClick={() => load(true)}>
                  Retry
                </button>
              </div>
            )}
            {options.map((o, i) => (
              <div
                key={o.custom ? "\0custom" : o.id}
                id={`${listId}-${i}`}
                data-i={i}
                role="option"
                aria-selected={i === active}
                className={`combo-opt${i === active ? " on" : ""}${o.custom ? " custom" : ""}`}
                onMouseMove={() => setActive(i)}
                onClick={() => commit(o.id)}
              >
                <span className="tick">{o.id === value && <Check size={12} weight="bold" />}</span>
                {o.custom && <span className="combo-hint">Use custom id</span>}
                <Label text={o.id} ranges={o.ranges} />
              </div>
            ))}
            {models && (
              <div className="combo-foot">
                {query ? `${matches} of ${models.length} models match` : `${models.length} models`}
                <span className="spacer" />
                <span>↑↓ to move, ↵ to pick</span>
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
