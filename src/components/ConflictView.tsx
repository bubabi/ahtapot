import { ArrowSquareOut, Check, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { HIGHLIGHT_LIMIT, highlightLines, languageFor, Tok } from "../highlight";
import { actions, notify, useStore } from "../store";
import { splitPath } from "../util";
import { StatusBadge } from "./DetailPanel";

type Segment =
  | { kind: "text"; lines: string[] }
  | { kind: "conflict"; ours: string[]; base: string[] | null; theirs: string[]; oursLabel: string; baseLabel: string; theirsLabel: string };

function parseConflicts(text: string): Segment[] {
  const segments: Segment[] = [];
  let plain: string[] = [];
  let block: Extract<Segment, { kind: "conflict" }> | null = null;
  let part: "ours" | "base" | "theirs" = "ours";
  for (const line of text.split("\n")) {
    if (!block && line.startsWith("<<<<<<<")) {
      if (plain.length) segments.push({ kind: "text", lines: plain });
      plain = [];
      block = { kind: "conflict", ours: [], base: null, theirs: [], oursLabel: line.slice(7).trim(), baseLabel: "", theirsLabel: "" };
      part = "ours";
    } else if (block && part === "ours" && line.startsWith("|||||||")) {
      block.base = [];
      block.baseLabel = line.slice(7).trim();
      part = "base";
    } else if (block && part !== "theirs" && line === "=======") {
      part = "theirs";
    } else if (block && part === "theirs" && line.startsWith(">>>>>>>")) {
      block.theirsLabel = line.slice(7).trim();
      segments.push(block);
      block = null;
    } else if (block) {
      (part === "ours" ? block.ours : part === "base" ? block.base! : block.theirs).push(line);
    } else {
      plain.push(line);
    }
  }
  if (block) plain = [`<<<<<<< ${block.oursLabel}`, ...block.ours, ...(block.base ? ["|||||||", ...block.base] : []), ...(part === "theirs" ? ["=======", ...block.theirs] : []), ...plain];
  if (plain.length) segments.push({ kind: "text", lines: plain });
  return segments;
}

function render(segments: Segment[]): string {
  return segments
    .flatMap((s) =>
      s.kind === "text"
        ? s.lines
        : [`<<<<<<< ${s.oursLabel}`, ...s.ours, ...(s.base ? [`||||||| ${s.baseLabel}`, ...s.base] : []), "=======", ...s.theirs, `>>>>>>> ${s.theirsLabel}`],
    )
    .join("\n");
}

const FOLD = 10;

type Tokens = Map<string[], Tok[][]>;

/**
 * Tokens keyed by each segment's line array. Each side is tokenized as the whole file it
 * would produce, so constructs that span blocks stay correct.
 */
function conflictTokens(segments: Segment[], lang: string): Tokens {
  const out: Tokens = new Map();
  for (const side of ["ours", "base", "theirs"] as const) {
    const parts = segments.map((s) => (s.kind === "text" ? s.lines : side === "base" ? (s.base ?? s.ours) : s[side]));
    const toks = highlightLines(parts.flat(), lang);
    let at = 0;
    segments.forEach((s, i) => {
      const lines = parts[i];
      const owned = s.kind === "text" ? side === "ours" : side !== "base" || s.base !== null;
      if (owned) out.set(lines, toks.slice(at, at + lines.length));
      at += lines.length;
    });
  }
  return out;
}

function Lines({ lines, toks, start, cls }: { lines: string[]; toks?: Tok[][]; start: number; cls?: string }) {
  return (
    <div className={`cf-lines${cls ? " " + cls : ""}`}>
      {lines.map((line, i) => (
        <div key={i} className="cf-line">
          <span className="ln">{start + i}</span>
          <span className="code">
            {!line ? " " : toks?.[i] ? toks[i].map((t, k) => <span key={k} className={t.cls || undefined}>{t.text}</span>) : line}
          </span>
        </div>
      ))}
    </div>
  );
}

function TextBlock({ lines, toks, start, first, last }: { lines: string[]; toks?: Tok[][]; start: number; first: boolean; last: boolean }) {
  const [open, setOpen] = useState(false);
  if (open || lines.length <= FOLD * 2 + 4) return <Lines lines={lines} toks={toks} start={start} />;
  const head = first ? 0 : FOLD;
  const tail = last ? 0 : FOLD;
  return (
    <>
      {head > 0 && <Lines lines={lines.slice(0, head)} toks={toks?.slice(0, head)} start={start} />}
      <button className="cf-fold" onClick={() => setOpen(true)}>
        Show {lines.length - head - tail} unchanged lines
      </button>
      {tail > 0 && <Lines lines={lines.slice(lines.length - tail)} toks={toks?.slice(lines.length - tail)} start={start + lines.length - tail} />}
    </>
  );
}

export function ConflictView({ path }: { path: string }) {
  const active = useStore((s) => s.active!);
  const busy = useStore((s) => s.busy);
  const syntax = useStore((s) => s.settings.syntax);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setText(null);
    api.readFile(active, path).then(
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
  }, [active, path]);

  const segments = useMemo(() => (text == null ? [] : parseConflicts(text)), [text]);
  const remaining = segments.filter((s) => s.kind === "conflict").length;
  const lang = syntax && text != null && text.length <= HIGHLIGHT_LIMIT ? languageFor(path) : null;
  const tokens = useMemo(() => (lang ? conflictTokens(segments, lang) : new Map() as Tokens), [segments, lang]);

  const choose = async (index: number, pick: "ours" | "theirs" | "both" | "base") => {
    const next = segments.map((s, i): Segment => {
      if (i !== index || s.kind !== "conflict") return s;
      const lines = pick === "ours" ? s.ours : pick === "theirs" ? s.theirs : pick === "base" ? (s.base ?? []) : [...s.ours, ...s.theirs];
      return { kind: "text", lines };
    });
    const out = render(next);
    try {
      await api.writeFile(active, path, out);
      setText(out);
    } catch (e) {
      notify("error", String(e));
    }
  };

  const close = () => useStore.setState({ diff: null });
  const [dir, name] = splitPath(path);
  let line = 1;

  return (
    <div className="diff-view" onKeyDown={(e) => e.key === "Escape" && close()} tabIndex={-1}>
      <div className="diff-head">
        <button className="icon-btn" title="Close (Esc)" onClick={close}>
          <X size={15} />
        </button>
        <StatusBadge status="U" />
        <span className="diff-path" title={path}>
          <span className="dir">{dir}</span>
          {name}
        </span>
        <span className="sha-chip">{text == null ? "conflicted" : remaining ? `${remaining} conflict${remaining === 1 ? "" : "s"} left` : "no markers left"}</span>
        <span className="spacer" />
        <button className="btn small" disabled={!!busy} onClick={() => actions.resolve(path, "ours")} title="git checkout --ours">
          Keep HEAD version
        </button>
        <button className="btn small" disabled={!!busy} onClick={() => actions.resolve(path, "theirs")} title="git checkout --theirs">
          Keep incoming version
        </button>
        <button className="icon-btn" title="Open in editor" onClick={() => actions.openInEditor(path)}>
          <ArrowSquareOut size={14} />
        </button>
        <button className="btn small primary" disabled={!!busy || text == null || remaining > 0} onClick={() => actions.stage([path])}>
          <Check size={13} /> Mark resolved
        </button>
      </div>
      <div className="diff-scroll cf-scroll">
        {error && <div className="empty">{error}. Keep one version, or resolve it in your editor.</div>}
        {segments.map((s, i) => {
          if (s.kind === "text") {
            const start = line;
            line += s.lines.length;
            return <TextBlock key={i} lines={s.lines} toks={tokens.get(s.lines)} start={start} first={i === 0} last={i === segments.length - 1} />;
          }
          const start = line;
          line += s.ours.length + (s.base ? s.base.length + 1 : 0) + s.theirs.length + 3;
          return (
            <div key={i} className="cf-block">
              <div className="cf-bar ours">
                <span>Current</span>
                <span className="cf-ref">{s.oursLabel || "HEAD"}</span>
                <span className="spacer" />
                <button className="btn tiny" onClick={() => choose(i, "ours")}>Accept current</button>
                <button className="btn tiny" onClick={() => choose(i, "theirs")}>Accept incoming</button>
                <button className="btn tiny" onClick={() => choose(i, "both")}>Accept both</button>
                {s.base && <button className="btn tiny" onClick={() => choose(i, "base")}>Accept base</button>}
              </div>
              <Lines lines={s.ours} toks={tokens.get(s.ours)} start={start + 1} cls="ours" />
              {s.base && (
                <>
                  <div className="cf-bar base">Base</div>
                  <Lines lines={s.base} toks={tokens.get(s.base)} start={start + s.ours.length + 2} cls="base" />
                </>
              )}
              <div className="cf-bar theirs">
                <span>Incoming</span>
                <span className="cf-ref">{s.theirsLabel || "incoming"}</span>
              </div>
              <Lines lines={s.theirs} toks={tokens.get(s.theirs)} start={start + s.ours.length + (s.base ? s.base.length + 1 : 0) + 2} cls="theirs" />
            </div>
          );
        })}
      </div>
    </div>
  );
}
