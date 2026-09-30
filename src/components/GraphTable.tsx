import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, Globe, Laptop, Stack, Tag } from "@phosphor-icons/react";
import { memo, MouseEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Commit, Ref } from "../api";
import { GraphRow, laneColor, layout, Seg, WIP } from "../graph";
import { ROW } from "../settings";
import { actions, changeCount, loadMore, MenuItem, openMenu, select, useStore } from "../store";
import { basename, formatDate } from "../util";
import { Avatar } from "./Avatar";
import { explainCommit } from "./Explain";

const LANE_W = 20;
const X0 = 22;
const laneX = (lane: number) => X0 + lane * LANE_W;

type PillKind = "head" | "local" | "both" | "remote" | "tag";
interface Pill {
  label: string;
  kind: PillKind;
  ref: Ref;
}

const RANK: Record<PillKind, number> = { head: 0, both: 1, local: 2, remote: 3, tag: 4 };

function pillsBySha(refs: Ref[]): Map<string, Pill[]> {
  const map = new Map<string, Pill[]>();
  const add = (pill: Pill) => {
    const list = map.get(pill.ref.sha) ?? [];
    list.push(pill);
    map.set(pill.ref.sha, list);
  };
  const twins = new Set<string>();
  for (const r of refs) {
    if (r.kind !== "local") continue;
    const twin = refs.find((x) => x.kind === "remote" && x.short === r.upstream && x.sha === r.sha);
    if (twin) twins.add(twin.name);
    add({ label: r.short, kind: r.isHead ? "head" : twin ? "both" : "local", ref: r });
  }
  for (const r of refs) {
    if (r.kind === "remote" && !twins.has(r.name)) add({ label: r.short.slice(r.short.indexOf("/") + 1), kind: "remote", ref: r });
    if (r.kind === "tag") add({ label: r.short, kind: "tag", ref: r });
  }
  for (const list of map.values()) list.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
  return map;
}

const BEND = 4;

function segPath(s: Seg, h: number): string {
  const yc = h / 2;
  const a = laneX(s.from);
  const b = laneX(s.to);
  if (s.half === "full") return `M${a},0V${h}`;
  if (s.half === "top") {
    if (a === b) return `M${a},0V${yc}`;
    const t = Math.min(1, BEND / Math.hypot(b - a, yc - BEND));
    return `M${a},0Q${a},${BEND} ${a + (b - a) * t},${BEND + (yc - BEND) * t}L${b},${yc}`;
  }
  if (a === b) return `M${a},${yc}V${h}`;
  const t = Math.min(1, BEND / Math.hypot(b - a, h - BEND - yc));
  return `M${a},${yc}L${b - (b - a) * t},${h - BEND - (h - BEND - yc) * t}Q${b},${h - BEND} ${b},${h}`;
}

interface CellProps {
  row: GraphRow;
  width: number;
  height: number;
  commit: Commit | null;
  tip: boolean;
  clipped: boolean;
}

const GraphCell = memo(function GraphCell({ row, width, height, commit, tip, clipped }: CellProps) {
  const yc = height / 2;
  const x = laneX(row.lane);
  const color = laneColor(row.color);
  const avatar = height - 6;
  let node = null;
  if (!commit) {
    node = <circle cx={x} cy={yc} r={4.25} style={{ fill: "var(--panel)" }} stroke={color} strokeWidth={1.5} />;
  } else if (!row.avatar) {
    node = row.merge ? (
      <circle cx={x} cy={yc} r={4.5} style={{ fill: "var(--panel)" }} stroke={color} strokeWidth={2} />
    ) : (
      <circle cx={x} cy={yc} r={4.5} fill={color} />
    );
  }
  return (
    <div className={`cell graph${clipped ? " clipped" : ""}`} style={{ width }}>
      {tip && <span className="tip-line" style={{ width: x, background: color }} />}
      <svg width={width} height={height}>
        <g fill="none" strokeWidth={2} strokeLinecap="round">
          {row.segs.map((s, i) => (
            <path key={i} d={segPath(s, height)} stroke={laneColor(s.color)} strokeDasharray={s.dashed ? "1 4" : undefined} />
          ))}
          {!commit && <path d={`M${x},0V${yc}`} stroke={color} strokeDasharray="1 4" />}
        </g>
        {node}
      </svg>
      {row.avatar && commit && (
        <span className="graph-avatar" style={{ left: x - avatar / 2, top: yc - avatar / 2 }}>
          <Avatar name={commit.author} email={commit.email} size={avatar} ring={color} />
        </span>
      )}
    </div>
  );
});

const PILL_ICON: Record<PillKind, typeof Check> = { head: Check, local: Laptop, both: Globe, remote: Globe, tag: Tag };
const SEP: MenuItem = { separator: true, label: "" };

export function refMenu(ref: Ref): MenuItem[] {
  const current = useStore.getState().snap?.status.branch;
  const copy = { label: "Copy name", run: () => actions.copy(ref.short, "name") };
  if (ref.kind === "tag")
    return [
      { label: `Checkout ${ref.short} (detached)`, run: () => actions.checkout(ref.sha, "commit") },
      { label: `Create branch from ${ref.short}…`, run: () => actions.createBranch(ref.sha) },
      SEP,
      { label: "Push tag", run: () => actions.pushTag(ref.short) },
      { label: "Delete tag…", run: () => actions.deleteTag(ref.short), danger: true },
      SEP,
      copy,
    ];
  const into = current ? ` into ${current}` : "";
  const mergeRebase: MenuItem[] = [
    { label: `Merge ${ref.short}${into}…`, run: () => actions.merge(ref.short), disabled: ref.isHead || !current },
    { label: `Rebase ${current ?? "HEAD"} onto ${ref.short}…`, run: () => actions.rebase(ref.short), disabled: ref.isHead || !current },
  ];
  if (ref.kind === "remote")
    return [
      { label: `Checkout ${ref.short}`, run: () => actions.checkout(ref.short, "remote") },
      { label: `Create branch from ${ref.short}…`, run: () => actions.createBranch(ref.sha) },
      SEP,
      ...mergeRebase,
      SEP,
      { label: `Delete ${ref.short} on the remote…`, run: () => actions.deleteRemoteBranch(ref.short), danger: true },
      copy,
    ];
  return [
    { label: `Checkout ${ref.short}`, run: () => actions.checkout(ref.short, "local"), disabled: ref.isHead },
    { label: `Create branch from ${ref.short}…`, run: () => actions.createBranch(ref.sha) },
    SEP,
    ...mergeRebase,
    SEP,
    { label: ref.upstream ? `Push to ${ref.upstream}` : "Push and set upstream", run: () => actions.push(false, ref.short) },
    { label: "Force push (with lease)…", run: () => actions.push(true, ref.short), disabled: !ref.upstream },
    SEP,
    { label: "Rename…", run: () => actions.renameBranch(ref.short) },
    { label: "Delete…", run: () => actions.deleteBranch(ref.short), danger: true, disabled: ref.isHead },
    copy,
  ];
}

function checkoutPill(p: Pill) {
  if (p.kind === "head") return;
  if (p.kind === "tag") actions.checkout(p.ref.sha, "commit");
  else actions.checkout(p.ref.short, p.kind === "remote" ? "remote" : "local");
}

function RefCell({ pills, width, color, repoName }: { pills?: Pill[]; width: number; color: string; repoName?: string }) {
  if (repoName) {
    return (
      <div className="cell ref" style={{ width }}>
        <span className="pill wip">
          <Stack size={11} weight="fill" />
          {repoName}
        </span>
      </div>
    );
  }
  if (!pills?.length) return <div className="cell ref" style={{ width }} />;
  const [first, ...rest] = pills;
  const Icon = PILL_ICON[first.kind];
  const onMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, refMenu(first.ref));
  };
  return (
    <div className="cell ref" style={{ width }}>
      <span className={`pill ${first.kind}`} title={pills.map((p) => p.ref.short).join("\n")} onDoubleClick={() => checkoutPill(first)} onContextMenu={onMenu}>
        <Icon size={11} weight={first.kind === "head" || first.kind === "tag" ? "bold" : "regular"} />
        <span className="pill-label">{first.label}</span>
      </span>
      {rest.length > 0 && <span className="pill more">+{rest.length}</span>}
      <span className="ref-line" style={{ background: color }} />
    </div>
  );
}

interface Cols {
  ref: number;
  graph: number;
  date: number;
  sha: number;
}

const DEFAULT_COLS: Cols = { ref: 175, graph: 160, date: 98, sha: 132 };

function loadCols(): Cols {
  try {
    return { ...DEFAULT_COLS, ...JSON.parse(localStorage.getItem("ahtapot.columns") ?? "{}") };
  } catch {
    return DEFAULT_COLS;
  }
}

function saveCols(cols: Cols) {
  try {
    localStorage.setItem("ahtapot.columns", JSON.stringify(cols));
  } catch {
    /* storage unavailable */
  }
}

function commitMenu(commit: Commit): MenuItem[] {
  const { snap, active } = useStore.getState();
  const branch = snap?.status.branch;
  const isHead = commit.sha === snap?.status.head;
  const target = branch ?? "HEAD";
  return [
    { label: "Checkout this commit (detached)", run: () => actions.checkout(commit.sha, "commit"), disabled: isHead },
    { label: "Create branch here…", run: () => actions.createBranch(commit.sha) },
    { label: "Create tag here…", run: () => actions.createTag(commit.sha) },
    SEP,
    { label: `Cherry-pick onto ${target}`, run: () => actions.cherryPick(commit.sha), disabled: isHead },
    { label: "Revert this commit", run: () => actions.revert(commit.sha) },
    SEP,
    { label: `Reset ${target} here (soft)…`, run: () => actions.reset(commit.sha, "soft"), disabled: isHead },
    { label: `Reset ${target} here (mixed)…`, run: () => actions.reset(commit.sha, "mixed"), disabled: isHead },
    { label: `Reset ${target} here (hard)…`, run: () => actions.reset(commit.sha, "hard"), danger: true, disabled: isHead },
    SEP,
    {
      label: "Explain with AI",
      run: () => {
        if (!active) return;
        select(commit.sha);
        explainCommit(active, commit.sha);
      },
    },
    { label: "Copy SHA", run: () => actions.copy(commit.sha, "SHA") },
    { label: "Copy subject", run: () => actions.copy(commit.subject, "subject") },
  ];
}

function wipMenu(): MenuItem[] {
  const snap = useStore.getState().snap;
  const unstaged = snap?.status.unstaged ?? [];
  return [
    { label: "Stage all changes", run: () => actions.stage(unstaged.map((f) => f.path)), disabled: !unstaged.length },
    { label: "Stash changes…", run: () => actions.stash() },
    SEP,
    {
      label: "Discard all unstaged changes…",
      danger: true,
      disabled: !unstaged.length,
      run: () =>
        actions.discard(
          unstaged.filter((f) => f.status !== "?").map((f) => f.path),
          unstaged.filter((f) => f.status === "?").map((f) => f.path),
        ),
    },
  ];
}

export function GraphTable() {
  const { commits, snap, selected, active, jump, settings } = useStore(
    useShallow((s) => ({ commits: s.commits, snap: s.snap, selected: s.selected, active: s.active, jump: s.jump, settings: s.settings })),
  );
  const [cols, setCols] = useState(loadCols);
  const [tableWidth, setTableWidth] = useState(1000);
  const [gutter, setGutter] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLDivElement>(null);
  const rowH = ROW[settings.density];

  const changes = changeCount(snap);
  const inProgress = !!snap?.status.state;
  const head = snap?.status.head ?? null;
  const showWip = changes > 0 || inProgress;
  const items: (Commit | null)[] = useMemo(() => (showWip ? [null, ...commits] : commits), [showWip, commits]);
  const rows = useMemo(
    () => layout(items.map((c) => (c ? c : { sha: WIP, parents: head ? [head] : [] }))),
    [items, head],
  );
  const pills = useMemo(() => pillsBySha(snap?.refs ?? []), [snap?.refs]);

  useLayoutEffect(() => {
    const el = table.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setTableWidth(el.clientWidth);
      if (scroll.current) setGutter(scroll.current.offsetWidth - scroll.current.clientWidth);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const lanes = useMemo(() => rows.reduce((m, r) => Math.max(m, r.width), 1), [rows]);
  const needed = laneX(lanes - 1) + 22;
  const graphW = cols.graph;
  const clipped = needed > graphW;
  const roomy = tableWidth - cols.ref - graphW - 240;
  const showDate = roomy >= cols.date;
  const showSha = roomy >= cols.date + cols.sha;

  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => rowH,
    overscan: 24,
  });

  useEffect(() => virtual.measure(), [rowH]);

  const visible = virtual.getVirtualItems();
  const last = visible[visible.length - 1]?.index ?? 0;
  useEffect(() => {
    if (last > items.length - 200) loadMore();
  }, [last, items.length]);

  useEffect(() => {
    if (!jump) return;
    const index = items.findIndex((c) => c?.sha === jump.sha);
    if (index < 0) return;
    useStore.setState({ jump: null });
    virtual.scrollToIndex(index, { align: "center" });
  }, [jump, items]);

  const indexOf = (sha: string | null) => items.findIndex((c) => (c ? c.sha === sha : sha === WIP));

  const onKey = (e: React.KeyboardEvent) => {
    const step = { ArrowDown: 1, ArrowUp: -1, j: 1, k: -1, PageDown: 20, PageUp: -20 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = indexOf(selected);
    const next = Math.max(0, Math.min(items.length - 1, i + step));
    const item = items[next];
    useStore.setState({ diff: null });
    select(item ? item.sha : WIP);
    virtual.scrollToIndex(next, { align: "auto" });
  };

  const resize = (key: keyof Cols, sign: 1 | -1) => (e: React.PointerEvent) => {
    e.preventDefault();
    const start = e.clientX;
    const initial = cols[key];
    let latest = cols;
    const move = (ev: PointerEvent) => {
      latest = { ...latest, [key]: Math.max(60, Math.min(900, initial + sign * (ev.clientX - start))) };
      setCols(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      saveCols(latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const reset = (key: keyof Cols) => () => {
    const next = { ...cols, [key]: DEFAULT_COLS[key] };
    setCols(next);
    saveCols(next);
  };

  const handle = (key: keyof Cols, sign: 1 | -1) => (
    <span className={`resizer${sign < 0 ? " left" : ""}`} onPointerDown={resize(key, sign)} onDoubleClick={reset(key)} title="Drag to resize, double-click to reset" />
  );

  const repoName = active ? basename(active) : "";

  return (
    <div className={`graph-table ${settings.density}`} ref={table}>
      <div className="graph-header" ref={header} style={{ paddingRight: gutter }}>
        <div className="hcell" style={{ width: cols.ref }}>
          Branch / Tag
          {handle("ref", 1)}
        </div>
        <div className="hcell" style={{ width: graphW }}>
          Graph
          {handle("graph", 1)}
        </div>
        <div className="hcell grow">Commit message</div>
        {showDate && (
          <div className="hcell" style={{ width: cols.date }}>
            {handle("date", -1)}
            Date
          </div>
        )}
        {showSha && (
          <div className="hcell" style={{ width: cols.sha }}>
            {handle("sha", -1)}
            SHA
          </div>
        )}
      </div>
      <div
        className="graph-scroll"
        ref={scroll}
        tabIndex={0}
        onKeyDown={onKey}
        onScroll={(e) => header.current && (header.current.scrollLeft = e.currentTarget.scrollLeft)}
      >
        <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
          {visible.map((v) => {
            const commit = items[v.index];
            const row = rows[v.index];
            const sha = commit ? commit.sha : WIP;
            const refPills = commit ? pills.get(commit.sha) : undefined;
            const color = laneColor(row.color);
            return (
              <div
                key={sha}
                className={`grow-row${selected === sha ? " selected" : ""}${commit && commit.sha === head ? " head" : ""}`}
                style={{ transform: `translateY(${v.start}px)`, height: rowH }}
                onMouseDown={() => {
                  if (selected !== sha) useStore.setState({ diff: null });
                  select(sha);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openMenu(e.clientX, e.clientY, commit ? commitMenu(commit) : wipMenu());
                }}
              >
                <RefCell pills={refPills} width={cols.ref} color={color} repoName={commit ? undefined : repoName} />
                <GraphCell row={row} width={graphW} height={rowH} commit={commit} tip={!!refPills} clipped={clipped} />
                <div className="cell msg">
                  {commit ? (
                    <>
                      <span className="subject">
                        {commit.subject}
                        {settings.showBody && commit.body && <span className="msg-body"> - {commit.body.replace(/^[-*\u2022]\s+/, "")}</span>}
                      </span>
                    </>
                  ) : (
                    <>
                      <Stack size={13} weight="fill" className="wip-icon" />
                      <span className="subject wip">{inProgress ? `${snap!.status.state![0].toUpperCase()}${snap!.status.state!.slice(1)} in ${repoName}` : `Uncommitted changes in ${repoName}`}</span>
                      <span className="count-badge">
                        {changes} change{changes === 1 ? "" : "s"}
                      </span>
                    </>
                  )}
                </div>
                {showDate && (
                  <div className="cell date" style={{ width: cols.date }} title={commit ? new Date(commit.time * 1000).toLocaleString() : undefined}>
                    {commit && formatDate(commit.time, settings.dateFormat)}
                  </div>
                )}
                {showSha && (
                  <div className="cell sha" style={{ width: cols.sha }}>
                    {commit?.sha.slice(0, 7)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {items.length === 0 && snap && <div className="empty">No commits yet</div>}
      </div>
    </div>
  );
}
