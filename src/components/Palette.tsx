import { GitBranch, GitCommit, Lightning, MagnifyingGlass } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api, Commit, Ref } from "../api";
import { actions, jumpTo, pickRepo, refresh, useStore } from "../store";
import { shortTime } from "../util";

const NO_REFS: Ref[] = [];

interface Item {
  kind: "action" | "branch" | "commit";
  label: string;
  hint?: string | string[];
  run: () => void;
}

function staticActions(): Item[] {
  const a = (label: string, run: () => void, hint?: string): Item => ({ kind: "action", label, run, hint });
  const { snap } = useStore.getState();
  const state = snap?.status.state;
  const head = snap?.status.head;
  return [
    ...(state
      ? [a(`Continue ${state.replace(/ing$/, "")}`, () => actions.sequence("continue")), a(`Abort ${state.replace(/ing$/, "")}`, () => actions.sequence("abort"))]
      : []),
    a("Fetch all remotes", () => actions.fetch(), "⇧⌘F"),
    a("Pull (fast-forward if possible)", () => actions.pull("ff")),
    a("Pull (fast-forward only)", () => actions.pull("ff-only")),
    a("Pull (rebase)", () => actions.pull("rebase")),
    a("Push", () => actions.push(false), "⇧⌘P"),
    a("Force push (with lease)…", () => actions.push(true)),
    a("Create branch…", () => actions.createBranch(), "⇧⌘B"),
    ...(head ? [a("Create tag at HEAD…", () => actions.createTag(head))] : []),
    a("Stash changes…", actions.stash, "⇧⌘S"),
    a("Pop latest stash", () => actions.pop(0)),
    a("Add remote…", actions.addRemote),
    a("Undo", actions.undo, "⌘Z"),
    a("Redo", actions.redo, "⇧⌘Z"),
    a("Refresh", () => refresh(true), "⌘R"),
    a("Open in editor", () => actions.openInEditor(), "⇧⌘E"),
    a("Reveal in Finder", () => actions.reveal()),
    a("Toggle terminal", actions.toggleTerminal, "⌘J"),
    a("Toggle sidebar", actions.toggleSidebar, "⌘B"),
    a("Toggle details", actions.toggleDetail, "⌥⌘B"),
    a("Open repository…", pickRepo, "⌘O"),
    a("Settings…", actions.openSettings, "⌘,"),
  ];
}

const commitItem = (c: Commit): Item => ({
  kind: "commit",
  label: c.subject,
  hint: [c.sha.slice(0, 7), c.author, shortTime(c.time)],
  run: () => jumpTo(c.sha),
});

/** Subsequence match; lower is better, -1 means no match. */
function score(text: string, query: string): number {
  const t = text.toLowerCase();
  const direct = t.indexOf(query);
  if (direct >= 0) return direct;
  let pos = 0;
  let gaps = 0;
  for (const ch of query) {
    const next = t.indexOf(ch, pos);
    if (next < 0) return -1;
    gaps += next - pos;
    pos = next + 1;
  }
  return 100 + gaps;
}

export function Palette() {
  const { open, refs, commits, active } = useStore(
    useShallow((s) => ({ open: s.paletteOpen, refs: s.snap?.refs ?? NO_REFS, commits: s.commits, active: s.active })),
  );
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ query: string; commits: Commit[] }>({ query: "", commits: [] });
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    if (!active || q.length < 3) return;
    const timer = setTimeout(() => {
      api.searchCommits(active, q, 60).then((list) => setFound({ query: q, commits: list }), () => {});
    }, 180);
    return () => clearTimeout(timer);
  }, [query, active]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const branches: Item[] = refs
      .filter((r) => r.kind !== "tag")
      .map((r) => ({
        kind: "branch" as const,
        label: r.short,
        hint: r.kind === "remote" ? "remote" : r.isHead ? "current" : "local",
        run: () => (r.isHead ? jumpTo(r.sha) : actions.checkout(r.short, r.kind === "remote" ? "remote" : "local")),
      }));
    if (!q) return [...staticActions(), ...branches.slice(0, 30)];

    const ranked = [...staticActions(), ...branches]
      .map((item) => ({ item, s: score(item.label, q) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => a.s - b.s)
      .map((x) => x.item)
      .slice(0, 40);
    const seen = new Set<string>();
    const matches: Item[] = [];
    for (const c of commits) {
      if (matches.length >= 40) break;
      if (c.sha.startsWith(q) || c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q)) {
        seen.add(c.sha);
        matches.push(commitItem(c));
      }
    }
    if (found.query.toLowerCase() === q) {
      for (const c of found.commits) if (!seen.has(c.sha)) matches.push(commitItem(c));
    }
    return [...ranked, ...matches];
  }, [query, refs, commits, found]);

  useEffect(() => {
    const box = list.current;
    const item = box?.querySelector<HTMLElement>(".pal-item.on");
    if (!box || !item) return;
    const pad = parseFloat(getComputedStyle(box).paddingTop);
    if (item.offsetTop - pad < box.scrollTop) box.scrollTop = item.offsetTop - pad;
    else if (item.offsetTop + item.offsetHeight + pad > box.scrollTop + box.clientHeight) box.scrollTop = item.offsetTop + item.offsetHeight + pad - box.clientHeight;
  }, [index]);

  if (!open) return null;
  const close = () => useStore.setState({ paletteOpen: false });
  const runItem = (item: Item | undefined) => {
    if (!item) return;
    close();
    item.run();
  };

  const ICON = { action: Lightning, branch: GitBranch, commit: GitCommit };
  return (
    <div className="scrim top" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="pal-input">
          <MagnifyingGlass size={15} />
          <input
            ref={input}
            value={query}
            placeholder="Search commits, branches, or run a command…"
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(items.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") runItem(items[index]);
            }}
          />
        </div>
        <div className="pal-list" ref={list}>
          {items.map((item, i) => {
            const Icon = ICON[item.kind];
            return (
              <div key={item.kind + item.label + i} className={`pal-item${i === index ? " on" : ""}`} onMouseMove={() => setIndex(i)} onClick={() => runItem(item)}>
                <Icon size={14} className="icon" />
                <span className="pal-label">{item.label}</span>
                {item.hint && (
                  <span className="pal-hint">
                    {[item.hint].flat().map((part, i) => (
                      <span key={i}>{part}</span>
                    ))}
                  </span>
                )}
              </div>
            );
          })}
          {items.length === 0 && <div className="pal-empty">No matches</div>}
        </div>
      </div>
    </div>
  );
}
