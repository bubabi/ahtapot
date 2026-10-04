import { Archive, ArrowUUpLeft, ArrowUUpRight, ArrowsClockwise, Bell, CaretDown, DotsThree, DownloadSimple, GitBranch, GitCommit, MagnifyingGlass, Rewind, SidebarSimple, SlidersHorizontal, TerminalWindow, UploadSimple } from "@phosphor-icons/react";
import { MouseEvent, ReactNode, RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { WIP } from "../graph";
import { actions, jumpTo, MenuItem, openRepo, pickRepo, refresh, removeRepo, toggleMenu, useStore } from "../store";
import { basename, relativeTime } from "../util";
import { RepoTile } from "./ProjectTile";

function Btn({ title, onClick, disabled, on, children, className }: { title: string; onClick: (e: MouseEvent) => void; disabled?: boolean; on?: boolean; children: ReactNode; className?: string }) {
  return (
    <button className={`tb-btn${on ? " on" : ""}${className ? " " + className : ""}`} title={title} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

/** Open state for a popover that closes on mousedown outside `anchor`. */
function usePopover(anchor: RefObject<HTMLElement | null>): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: globalThis.MouseEvent) => {
      if (!anchor.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  return [open, setOpen];
}

/** Parts that give up their space, in order, when the bar is too narrow. */
const UNITS = ["search", "tools", "history", "commit"] as const;
const MIN_GAP = 24;

/** How many of `UNITS` are collapsed so the bar fits its width. */
function useCollapse(header: RefObject<HTMLElement | null>): number {
  const [level, setLevel] = useState(0);
  const current = useRef(0);
  const widths = useRef(new Map<string, number>());
  current.current = level;

  const fit = () => {
    const el = header.current;
    if (!el) return;
    for (const unit of el.querySelectorAll<HTMLElement>("[data-unit]")) {
      const gap = parseFloat(getComputedStyle(unit.parentElement!).columnGap) || 0;
      widths.current.set(unit.dataset.unit!, unit.getBoundingClientRect().width + parseFloat(getComputedStyle(unit).marginLeft) + gap);
    }
    const bar = el.getBoundingClientRect();
    const leftEnd = Math.max(...[...el.querySelector(".tb-left")!.children].map((c) => c.getBoundingClientRect().right));
    const center = el.querySelector(".tb-center")!.getBoundingClientRect().width;
    const rightStart = el.querySelector(".tb-right > *")!.getBoundingClientRect().left;
    let need = leftEnd - bar.left + center + (bar.right - rightStart) + MIN_GAP;
    const saving = (l: number) => {
      const unit = UNITS[l - 1];
      const full = widths.current.get(unit);
      if (full === undefined) return undefined;
      return unit === "search" ? full - (widths.current.get("search-compact") ?? 41) : full;
    };
    let next = current.current;
    while (need > bar.width && next < UNITS.length) need -= saving(++next) ?? 0;
    while (next > 0) {
      const s = saving(next);
      if (s === undefined || need + s > bar.width - 4) break;
      need += s;
      next--;
    }
    if (next !== current.current) setLevel(next);
  };

  useLayoutEffect(fit);
  useEffect(() => {
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  return level;
}

export function TopBar() {
  const { active, repos, snap, selected, busy, terminalOpen, notes } = useStore(
    useShallow((s) => ({
      active: s.active,
      repos: s.repos,
      snap: s.snap,
      selected: s.selected,
      busy: s.busy,
      terminalOpen: s.terminalOpen,
      notes: s.notes,
    })),
  );
  const bar = useRef<HTMLElement>(null);
  const level = useCollapse(bar);
  const bell = useRef<HTMLDivElement>(null);
  const [bellOpen, setBellOpen] = usePopover(bell);
  const [seen, setSeen] = useState(0);
  const status = snap?.status;
  const history = snap?.history;
  const unread = notes.filter((n) => n.id > seen).length;
  const disabled = !active || !!busy;

  const repoMenu = (e: MouseEvent) => {
    toggleMenu(e.currentTarget, [
      ...repos.map((r) => ({ label: basename(r), icon: <RepoTile path={r} />, checked: r === active, run: () => openRepo(r) })),
      { separator: true, label: "" },
      { label: "Open repository…", run: pickRepo },
      ...(active ? [{ label: `Remove ${basename(active)} from list`, run: () => removeRepo(active), danger: true }] : []),
    ]);
  };

  const pullMenu = (e: MouseEvent) => {
    e.stopPropagation();
    toggleMenu(e.currentTarget, [
      { label: "Fetch all", run: () => actions.fetch() },
      { label: "Pull (fast-forward if possible)", run: () => actions.pull("ff") },
      { label: "Pull (fast-forward only)", run: () => actions.pull("ff-only") },
      { label: "Pull (rebase)", run: () => actions.pull("rebase") },
    ]);
  };

  const createBranch = () => actions.createBranch(selected && selected !== WIP ? selected : undefined);

  const moreMenu = (e: MouseEvent) => {
    const collapsed: MenuItem[] = [
      ...(level >= 3
        ? [
            { label: history?.undo ? `Undo ${history.undo}` : "Undo", run: actions.undo, disabled: disabled || !history?.undo },
            { label: history?.redo ? `Redo ${history.redo}` : "Redo", run: actions.redo, disabled: disabled || !history?.redo },
          ]
        : []),
      ...(level >= 2
        ? [
            { label: "Create branch…", run: createBranch, disabled: disabled || !status?.head },
            { label: "Stash changes…", run: actions.stash, disabled },
            { label: terminalOpen ? "Hide terminal" : "Show terminal", run: actions.toggleTerminal, disabled: !active },
          ]
        : []),
    ];
    toggleMenu(e.currentTarget, [
      ...collapsed,
      ...(collapsed.length ? [{ separator: true, label: "" }] : []),
      { label: "Force push (with lease)…", run: () => actions.push(true), disabled },
      { label: "Pop latest stash", run: () => actions.pop(0), disabled: disabled || !snap?.stashes.length },
      { label: "Add remote…", run: actions.addRemote, disabled },
      { separator: true, label: "" },
      { label: "Open in editor", run: () => actions.openInEditor(), disabled: !active },
      { label: "Reveal in Finder", run: () => actions.reveal(), disabled: !active },
      { separator: true, label: "" },
      { label: "Open repository…", run: pickRepo },
      { label: "Settings…", run: actions.openSettings },
    ]);
  };

  return (
    <header className="topbar" ref={bar} data-tauri-drag-region>
      <div className="tb-left" data-tauri-drag-region>
        <div className="traffic-space" data-tauri-drag-region />
        <Btn title="Toggle sidebar (⌘B)" onClick={actions.toggleSidebar}>
          <SidebarSimple size={16} />
        </Btn>
        <span className="logo" title="Ahtapot">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="5.4" r="2.6" />
            <path d="M12,8 C12,10.6 4,10.4 4,12.8 V16.6 M12,8 C12,10.6 8,10.4 8,12.8 V18.8 M12,8 V17.7 M12,8 C12,10.6 16,10.4 16,12.8 V15.8 M12,8 C12,10.6 20,10.4 20,12.8 V18.4" />
            <g fill="currentColor" stroke="none">
              <circle cx="4" cy="18.2" r="1.5" />
              <circle cx="8" cy="20.4" r="1.5" />
              <circle cx="12" cy="19.3" r="1.5" />
              <circle cx="16" cy="17.4" r="1.5" />
              <circle cx="20" cy="20" r="1.5" />
            </g>
          </svg>
        </span>
        <span className="crumb-sep">/</span>
        {active ? (
          <button className="crumb repo" onClick={repoMenu}>
            <RepoTile path={active} size={22} />
            <span className="crumb-strong">{basename(active)}</span>
            <CaretDown size={13} weight="bold" className="crumb-caret" />
          </button>
        ) : (
          <button className="crumb" onClick={pickRepo}>
            Open repository…
          </button>
        )}
        {status && (
          <>
            <span className="crumb-sep">/</span>
            <button className="crumb branch" onClick={() => status.head && jumpTo(status.head)} title={status.upstream ?? "no upstream"}>
              <GitBranch size={14} />
              <span className="crumb-name">{status.branch ?? "detached"}</span>
              {(status.ahead > 0 || status.behind > 0) && (
                <span className="track-ab">
                  {status.ahead > 0 && <span><i>↑</i>{status.ahead}</span>}
                  {status.behind > 0 && <span><i>↓</i>{status.behind}</span>}
                </span>
              )}
            </button>
            {level < 4 && (
              <span className="tb-unit" data-unit="commit">
                <span className="crumb-sep">/</span>
                <span className="crumb commit">
                  <GitCommit size={12} className="crumb-icon" />
                  <span className="crumb-strong sha">{selected === WIP ? "WIP" : (selected ?? status.head ?? "").slice(0, 7)}</span>
                </span>
              </span>
            )}
          </>
        )}
      </div>
      <div className="tb-center" data-tauri-drag-region>
        <div className="tb-group">
          <Btn title="Refresh" onClick={() => refresh(true)} disabled={!active}>
            <ArrowsClockwise size={15} className={busy ? "spin" : undefined} />
          </Btn>
          <Btn title="Pull" onClick={() => actions.pull()} disabled={disabled} className="with-count">
            <DownloadSimple size={17} />
            {status && status.behind > 0 && <span className="count blue">{status.behind}</span>}
            <span className="caret" onClick={pullMenu}>
              <CaretDown size={8} weight="bold" />
            </span>
          </Btn>
          <Btn title="Push" onClick={() => actions.push(false)} disabled={disabled} className="with-count">
            <UploadSimple size={17} />
            {status && status.ahead > 0 && <span className="count blue">{status.ahead}</span>}
          </Btn>
        </div>
        {level < 3 && (
          <div className="tb-group" data-unit="history">
            <Btn title={history?.undo ? `Undo ${history.undo} (⌘Z)` : "Nothing to undo"} onClick={actions.undo} disabled={disabled || !history?.undo}>
              <ArrowUUpLeft size={14} />
            </Btn>
            <Btn title={history?.redo ? `Redo ${history.redo} (⇧⌘Z)` : "Nothing to redo"} onClick={actions.redo} disabled={disabled || !history?.redo}>
              <ArrowUUpRight size={14} />
            </Btn>
          </div>
        )}
        <div className="tb-group">
          {level < 2 && (
            <span className="tb-unit" data-unit="tools">
              <Btn title="Create branch" onClick={createBranch} disabled={disabled || !status?.head}>
                <GitBranch size={16} />
              </Btn>
              <Btn title="Stash changes" onClick={actions.stash} disabled={disabled}>
                <Archive size={15} />
              </Btn>
              <Btn title="Pop stash" onClick={() => actions.pop(0)} disabled={disabled || !snap?.stashes.length}>
                <Rewind size={12} />
              </Btn>
              <Btn title="Terminal (⌘J)" onClick={actions.toggleTerminal} on={terminalOpen} disabled={!active}>
                <TerminalWindow size={16} />
              </Btn>
            </span>
          )}
          <Btn title="More" onClick={moreMenu}>
            <DotsThree size={18} />
          </Btn>
        </div>
        {level < 1 ? (
          <span className="tb-unit tb-search" data-unit="search">
            <button className="search" onClick={actions.openPalette}>
              <MagnifyingGlass size={16} />
              <span>{busy ? `${busy}…` : "Search or run..."}</span>
              <kbd>⌘</kbd>
              <kbd>K</kbd>
            </button>
          </span>
        ) : (
          <span className="tb-unit tb-search" data-unit="search-compact">
            <Btn title={busy ? `${busy}…` : "Search or run (⌘K)"} onClick={actions.openPalette}>
              <MagnifyingGlass size={16} />
            </Btn>
          </span>
        )}
        <div className="popover-anchor" ref={bell}>
          <Btn
            title="Notifications"
            onClick={() => {
              setBellOpen(!bellOpen);
              setSeen(notes[0]?.id ?? 0);
            }}
          >
            <Bell size={16} />
            {unread > 0 && <span className="dot" />}
          </Btn>
          {bellOpen && (
            <div className="popover" onMouseDown={(e) => e.stopPropagation()}>
              <div className="pop-title">Activity</div>
              {notes.length === 0 && <div className="pop-empty">Nothing yet</div>}
              {notes.map((n) => (
                <div key={n.id} className={`pop-note ${n.kind}`}>
                  <span>{n.text}</span>
                  <span className="dim">{relativeTime(n.time)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <Btn title="Settings (⌘,)" onClick={actions.openSettings}>
          <SlidersHorizontal size={18} />
        </Btn>
      </div>
      <div className="tb-right" data-tauri-drag-region>
        <Btn title="Toggle details (⌥⌘B)" onClick={actions.toggleDetail}>
          <SidebarSimple size={16} style={{ transform: "scaleX(-1)" }} />
        </Btn>
      </div>
    </header>
  );
}
