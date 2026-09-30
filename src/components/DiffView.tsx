import { useVirtualizer } from "@tanstack/react-virtual";
import { Columns, Rows, X } from "@phosphor-icons/react";
import { MouseEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api";
import { changedRange, DiffLine, FileDiff, Hunk, hunkPatch, linesPatch, parseDiff, splitRows } from "../diff";
import { HIGHLIGHT_LIMIT, highlightHunks, languageFor, Tok } from "../highlight";
import { actions, DiffTarget, diffOpts, updateSettings, useStore } from "../store";
import { imageType, splitPath } from "../util";
import { ConflictView } from "./ConflictView";
import { StatusBadge } from "./DetailPanel";

type Row =
  | { t: "hunk"; hunk: Hunk; index: number }
  | { t: "line"; line: DiffLine; hunk: number; index: number }
  | { t: "split"; left: DiffLine | null; right: DiffLine | null };

type Ranges = Map<DiffLine, [number, number]>;
type Tokens = Map<DiffLine, Tok[]>;

interface Pick {
  hunk: number;
  lines: Set<number>;
  anchor: number;
}

function intraline(diff: FileDiff): Ranges {
  const ranges: Ranges = new Map();
  for (const hunk of diff.hunks) {
    for (const { left, right } of splitRows(hunk.lines)) {
      if (!left || !right || left.kind !== "del" || right.kind !== "add") continue;
      const [s1, e1, s2, e2] = changedRange(left.text, right.text);
      if (s1 === 0 && e1 === left.text.length && s2 === 0 && e2 === right.text.length) continue;
      ranges.set(left, [s1, e1]);
      ranges.set(right, [s2, e2]);
    }
  }
  return ranges;
}

function Code({ line, ranges, tokens }: { line: DiffLine; ranges: Ranges; tokens: Tokens }) {
  const toks = tokens.get(line) ?? [{ text: line.text, cls: "" }];
  const r = ranges.get(line);
  if (!line.text) return <span className="code"> </span>;
  let pos = 0;
  const out: React.ReactNode[] = [];
  toks.forEach((t, i) => {
    const start = pos;
    const end = pos + t.text.length;
    pos = end;
    if (!r || r[0] === r[1] || r[1] <= start || r[0] >= end) {
      out.push(<span key={i} className={t.cls || undefined}>{t.text}</span>);
      return;
    }
    const a = Math.max(r[0], start) - start;
    const b = Math.min(r[1], end) - start;
    if (a > 0) out.push(<span key={i + "a"} className={t.cls || undefined}>{t.text.slice(0, a)}</span>);
    out.push(
      <mark key={i + "m"} className={t.cls || undefined}>
        {t.text.slice(a, b)}
      </mark>,
    );
    if (b < t.text.length) out.push(<span key={i + "c"} className={t.cls || undefined}>{t.text.slice(b)}</span>);
  });
  return <span className="code">{out}</span>;
}

const SIGN = { add: "+", del: "-", ctx: " ", meta: " " };

function Side({ line, ranges, tokens, which }: { line: DiffLine | null; ranges: Ranges; tokens: Tokens; which: "left" | "right" }) {
  if (!line) return <div className="dside blank" />;
  const no = which === "left" ? line.oldNo : line.newNo;
  return (
    <div className={`dside ${line.kind}`}>
      <span className="ln">{no}</span>
      <Code line={line} ranges={ranges} tokens={tokens} />
    </div>
  );
}

function loadPatch(target: DiffTarget, repo: string): Promise<string> {
  const opts = diffOpts();
  if (target.kind === "commit") return api.diffCommit(repo, target.sha, target.path, target.origPath, opts);
  return api.diffWip(repo, target.path, target.origPath, target.staged, target.untracked, opts);
}

const plural = (n: number) => `${n} line${n === 1 ? "" : "s"}`;

export function DiffView({ target }: { target: DiffTarget }) {
  if (target.kind === "wip" && target.status === "U") return <ConflictView path={target.path} />;
  const image = imageType(target.path);
  if (image) return <ImageDiff target={target} type={image} />;
  return <PatchView target={target} />;
}

const close = () => useStore.setState({ diff: null });

function DiffHead({ target, children }: { target: DiffTarget; children?: ReactNode }) {
  const [dir, name] = splitPath(target.path);
  return (
    <div className="diff-head">
      <button className="icon-btn" title="Close (Esc)" onClick={close}>
        <X size={15} />
      </button>
      <StatusBadge status={target.status} />
      <span className="diff-path" title={target.path}>
        <span className="dir">{dir}</span>
        {name}
        {target.origPath && <span className="dir"> ← {target.origPath}</span>}
      </span>
      <span className="sha-chip">{target.kind === "commit" ? target.sha.slice(0, 7) : target.staged ? "staged" : "unstaged"}</span>
      <span className="spacer" />
      {children}
      {target.kind === "wip" &&
        (target.staged ? (
          <button className="btn small" onClick={() => actions.unstage(target.origPath ? [target.origPath, target.path] : [target.path])}>
            Unstage file
          </button>
        ) : (
          <button className="btn small primary" onClick={() => actions.stage([target.path])}>
            Stage file
          </button>
        ))}
    </div>
  );
}

interface Source {
  rev: string | null;
  path: string;
}

/** Where the before and after images live. A rev of "" is the index, null the worktree. */
function imageSources(t: DiffTarget): [Source | null, Source | null] {
  const old = t.origPath ?? t.path;
  const added = t.status === "A" || t.status === "?";
  const deleted = t.status === "D";
  if (t.kind === "commit") return [added ? null : { rev: `${t.sha}^`, path: old }, deleted ? null : { rev: t.sha, path: t.path }];
  if (t.staged) return [added ? null : { rev: "HEAD", path: old }, deleted ? null : { rev: "", path: t.path }];
  return [t.untracked ? null : { rev: "", path: t.path }, deleted ? null : { rev: null, path: t.path }];
}

interface Loaded {
  url: string;
  bytes: number;
}

function useImage(repo: string, source: Source | null, type: string, version: unknown): Loaded | null | undefined {
  const [image, setImage] = useState<Loaded | null | undefined>(undefined);
  useEffect(() => {
    let url: string | null = null;
    let live = true;
    setImage(undefined);
    if (!source) {
      setImage(null);
      return;
    }
    api.readBlob(repo, source.rev, source.path).then(
      (buf) => {
        if (!live) return;
        url = URL.createObjectURL(new Blob([buf], { type }));
        setImage({ url, bytes: buf.byteLength });
      },
      () => live && setImage(null),
    );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [repo, source?.rev, source?.path, type, version]);
  return image;
}

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function ImagePane({ label, image, tone }: { label: string; image: Loaded | null | undefined; tone: "del" | "add" }) {
  const [size, setSize] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  return (
    <figure className="img-side">
      <figcaption className={`img-cap ${tone}`}>
        <strong>{label}</strong>
        {size && <span>{size}</span>}
        {image && <span>{kb(image.bytes)}</span>}
      </figcaption>
      <div className="img-frame">
        {image === undefined && <span className="dim">Loading…</span>}
        {image === null && <span className="dim">{label === "Before" ? "Added in this change" : "Deleted in this change"}</span>}
        {image && broken && <span className="dim">This image format cannot be previewed</span>}
        {image && !broken && (
          <img
            src={image.url}
            alt={label}
            draggable={false}
            onLoad={(e) => setSize(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)}
            onError={() => setBroken(true)}
          />
        )}
      </div>
    </figure>
  );
}

function ImageDiff({ target, type }: { target: DiffTarget; type: string }) {
  const { active, snap } = useStore(useShallow((s) => ({ active: s.active!, snap: s.snap })));
  const [before, after] = useMemo(() => imageSources(target), [target]);
  const version = target.kind === "wip" ? snap : null;
  const left = useImage(active, before, type, version);
  const right = useImage(active, after, type, version);
  return (
    <div className="diff-view" onKeyDown={(e) => e.key === "Escape" && close()} tabIndex={-1}>
      <DiffHead target={target} />
      <div className="img-diff">
        <ImagePane key={`before:${left?.url ?? left}`} label="Before" image={left} tone="del" />
        <ImagePane key={`after:${right?.url ?? right}`} label="After" image={right} tone="add" />
      </div>
    </div>
  );
}

function PatchView({ target }: { target: DiffTarget }) {
  const { active, snap, busy, settings } = useStore(useShallow((s) => ({ active: s.active!, snap: s.snap, busy: s.busy, settings: s.settings })));
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<Pick | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const split = settings.diffView === "split";
  const { ignoreWhitespace, contextLines } = settings;

  useEffect(() => {
    let live = true;
    loadPatch(target, active).then(
      (t) => {
        if (!live) return;
        setText(t);
        setError(null);
      },
      (e) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [target, active, target.kind === "wip" ? snap : null, ignoreWhitespace, contextLines]);

  useEffect(() => setPick(null), [text]);

  const diff = useMemo(() => (text == null ? null : parseDiff(text)), [text]);
  const ranges = useMemo(() => (diff ? intraline(diff) : new Map()), [diff]);
  const lang = settings.syntax && (text?.length ?? 0) <= HIGHLIGHT_LIMIT ? languageFor(target.path) : null;
  const tokens: Tokens = useMemo(() => (diff && lang ? highlightHunks(diff.hunks, lang) : new Map()), [diff, lang]);
  const rows: Row[] = useMemo(() => {
    if (!diff) return [];
    const out: Row[] = [];
    diff.hunks.forEach((hunk, h) => {
      out.push({ t: "hunk", hunk, index: h });
      if (split) for (const r of splitRows(hunk.lines)) out.push({ t: "split", ...r });
      else hunk.lines.forEach((line, i) => out.push({ t: "line", line, hunk: h, index: i }));
    });
    return out;
  }, [diff, split]);

  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 20,
    overscan: 30,
  });

  const wip = target.kind === "wip" ? target : null;
  const canHunk = !!wip && !wip.untracked && !ignoreWhitespace;
  const canPick = canHunk && !split;

  const toggle = (e: MouseEvent, h: number, i: number) => {
    if (!canPick || !diff) return;
    const kind = diff.hunks[h].lines[i].kind;
    if (kind !== "add" && kind !== "del") return;
    e.preventDefault();
    setPick((prev) => {
      if (!prev || prev.hunk !== h) return { hunk: h, lines: new Set([i]), anchor: i };
      const lines = new Set(prev.lines);
      if (e.shiftKey) {
        const [a, b] = [Math.min(prev.anchor, i), Math.max(prev.anchor, i)];
        for (let k = a; k <= b; k++) {
          const kk = diff.hunks[h].lines[k].kind;
          if (kk === "add" || kk === "del") lines.add(k);
        }
        return { ...prev, lines };
      }
      lines.has(i) ? lines.delete(i) : lines.add(i);
      return lines.size ? { hunk: h, lines, anchor: i } : null;
    });
  };

  const hunkButtons = (hunk: Hunk, h: number) => {
    if (!canHunk || !diff || !wip) return null;
    const picked = pick?.hunk === h ? pick.lines : null;
    const patch = (reverse: boolean) => (picked ? linesPatch(diff, hunk, picked, reverse) : hunkPatch(diff, hunk));
    const what = picked ? plural(picked.size) : "hunk";
    if (wip.staged)
      return (
        <button className="btn tiny" disabled={!!busy} onClick={() => actions.applyPatch(patch(true), true)}>
          Unstage {what}
        </button>
      );
    return (
      <>
        {picked && (
          <button className="btn tiny ghost" onClick={() => setPick(null)}>
            Clear
          </button>
        )}
        <button className="btn tiny" disabled={!!busy} onClick={() => actions.discardPatch(patch(true), wip.path)}>
          Discard {what}
        </button>
        <button className="btn tiny" disabled={!!busy} onClick={() => actions.applyPatch(patch(false), false)}>
          Stage {what}
        </button>
      </>
    );
  };

  return (
    <div className={`diff-view${settings.wrap ? "" : " nowrap"}`} onKeyDown={(e) => e.key === "Escape" && close()} tabIndex={-1}>
      <DiffHead target={target}>
        {canPick && <span className="diff-hint">Click lines to pick them, ⇧-click for a range</span>}
        {wip && ignoreWhitespace && <span className="diff-hint">Hunk actions are off while whitespace is ignored</span>}
        <div className="seg">
          <button className={!split ? "on" : ""} onClick={() => updateSettings({ diffView: "unified" })}>
            <Rows size={12} /> Unified
          </button>
          <button className={split ? "on" : ""} onClick={() => updateSettings({ diffView: "split" })}>
            <Columns size={12} /> Split
          </button>
        </div>
      </DiffHead>
      <div className="diff-scroll" ref={scroll}>
        {error && <div className="empty">{error}</div>}
        {diff?.binary && <div className="empty">Binary file</div>}
        {diff && !diff.binary && diff.hunks.length === 0 && <div className="empty">{ignoreWhitespace ? "Only whitespace changed" : "No textual changes"}</div>}
        <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
          {virtual.getVirtualItems().map((v) => {
            const row = rows[v.index];
            const style = { transform: `translateY(${v.start}px)` };
            if (row.t === "hunk")
              return (
                <div key={v.key} ref={virtual.measureElement} data-index={v.index} className="drow dhunk" style={style}>
                  <span className="hunk-text">{row.hunk.header}</span>
                  <span className="hunk-actions">{hunkButtons(row.hunk, row.index)}</span>
                </div>
              );
            if (row.t === "split")
              return (
                <div key={v.key} ref={virtual.measureElement} data-index={v.index} className="drow dsplit" style={style}>
                  <Side line={row.left} ranges={ranges} tokens={tokens} which="left" />
                  <Side line={row.right} ranges={ranges} tokens={tokens} which="right" />
                </div>
              );
            const line = row.line;
            const picked = pick?.hunk === row.hunk && pick.lines.has(row.index);
            const pickable = canPick && (line.kind === "add" || line.kind === "del");
            return (
              <div key={v.key} ref={virtual.measureElement} data-index={v.index} className={`drow dline ${line.kind}${picked ? " picked" : ""}`} style={style}>
                <span className={`gutter${pickable ? " pickable" : ""}`} onMouseDown={(e) => toggle(e, row.hunk, row.index)}>
                  <span className="ln">{line.oldNo}</span>
                  <span className="ln">{line.newNo}</span>
                  <span className="sign">{SIGN[line.kind]}</span>
                </span>
                <Code line={line} ranges={ranges} tokens={tokens} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
