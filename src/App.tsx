import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { FolderOpen } from "@phosphor-icons/react";
import { Component, CSSProperties, PointerEvent, ReactNode, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { DetailPanel } from "./components/DetailPanel";
import { DiffView } from "./components/DiffView";
import { GraphTable } from "./components/GraphTable";
import { ContextMenu, DialogHost, Toasts } from "./components/Overlays";
import { Palette } from "./components/Palette";
import { ProjectEditor, RepoTile } from "./components/ProjectTile";
import { RepoRail } from "./components/RepoRail";
import { SettingsDialog } from "./components/Settings";
import { Sidebar } from "./components/Sidebar";
import { TerminalPane } from "./components/TerminalPane";
import { TopBar } from "./components/TopBar";
import { api } from "./api";
import { applyAppearance } from "./settings";
import { actions, addRepo, clampDetailWidth, DETAIL_WIDTH, handleMenu, init, notify, openRepo, pickRepo, saveDetailWidth, useStore } from "./store";

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  return !!el?.closest("input, textarea, .xterm");
}

/** ⌘Z is bound here, not in the menu, so text fields keep native undo. Menu accelerators cover the rest. */
function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { dialog, settingsOpen, projectEdit } = useStore.getState();
      if (isTyping(e) || dialog || settingsOpen || projectEdit) return;
      if (e.key === "Escape" && !e.metaKey) useStore.setState({ diff: null });
      if (e.metaKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        (e.shiftKey ? actions.redo : actions.undo)();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function useNativeEvents() {
  useEffect(() => {
    const menu = listen<string>("menu", (e) => handleMenu(e.payload));
    const drop = getCurrentWebview().onDragDropEvent(async (e) => {
      if (e.payload.type !== "drop") return;
      for (const path of e.payload.paths) await addRepo(path);
    });
    const onRejection = (e: PromiseRejectionEvent) => notify("error", String(e.reason));
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      menu.then((off) => off());
      drop.then((off) => off());
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <h1>Ahtapot hit an error</h1>
        <pre>{String(this.state.error.stack ?? this.state.error)}</pre>
        <button className="btn primary" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

function Welcome() {
  const repos = useStore((s) => s.repos);
  return (
    <div className="welcome">
      <FolderOpen size={40} weight="light" />
      <h1>Open a repository</h1>
      <p>Pick a folder that contains a git repository.</p>
      <button className="btn primary" onClick={pickRepo}>
        Open repository… <kbd>⌘O</kbd>
      </button>
      {repos.length > 0 && (
        <div className="recents">
          {repos.map((r) => (
            <button key={r} className="recent" onClick={() => openRepo(r)}>
              <RepoTile path={r} size={20} />
              <span>{r}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const MIN_GRAPH = 480;
let sidebarSpace = 232;

/** Hides the sidebar, then the details panel, while the graph would be narrower than MIN_GRAPH, and restores them once they fit. */
function useAutoPanels(active: string | null) {
  useEffect(() => {
    const fit = () => {
      const main = document.querySelector(".main");
      const sidebar = document.querySelector(".sidebar");
      const s = useStore.getState();
      if (!main || !s.active) return;
      if (sidebar) sidebarSpace = sidebar.getBoundingClientRect().width + parseFloat(getComputedStyle(sidebar).marginRight);
      const space = main.getBoundingClientRect().width + (s.sidebarOpen ? sidebarSpace : 0);
      const room = (open: boolean) => MIN_GRAPH + (open ? 0 : 16);
      const wantDetail = s.detailOpen || s.autoHidden.detail;
      const wantSidebar = s.sidebarOpen || s.autoHidden.sidebar;
      const detail = wantDetail && space - s.detailWidth >= room(s.detailOpen);
      const side = wantSidebar && (detail || !wantDetail) && space - (detail ? s.detailWidth : 0) - sidebarSpace >= room(s.sidebarOpen);
      if (detail === s.detailOpen && side === s.sidebarOpen) return;
      useStore.setState({ detailOpen: detail, sidebarOpen: side, autoHidden: { detail: wantDetail && !detail, sidebar: wantSidebar && !side } });
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [active]);
}

function DetailResizer() {
  const drag = (e: PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = useStore.getState().detailWidth;
    const graph = document.querySelector(".center")?.getBoundingClientRect().width ?? MIN_GRAPH;
    const limit = Math.max(w0, w0 + graph - MIN_GRAPH);
    const move = (ev: globalThis.PointerEvent) => useStore.setState({ detailWidth: clampDetailWidth(Math.min(limit, w0 + x0 - ev.clientX)) });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      saveDetailWidth(useStore.getState().detailWidth);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const reset = () => {
    useStore.setState({ detailWidth: DETAIL_WIDTH });
    saveDetailWidth(DETAIL_WIDTH);
  };
  return <div className="pane-resizer" onPointerDown={drag} onDoubleClick={reset} title="Drag to resize, double-click to reset" />;
}

export default function App() {
  const { active, sidebarOpen, terminalOpen, detailOpen, detailWidth, diff, settings } = useStore(
    useShallow((s) => ({
      active: s.active,
      sidebarOpen: s.sidebarOpen,
      terminalOpen: s.terminalOpen,
      detailOpen: s.detailOpen,
      detailWidth: s.detailWidth,
      diff: s.diff,
      settings: s.settings,
    })),
  );
  useShortcuts();
  useNativeEvents();
  useAutoPanels(active);
  useEffect(() => {
    init().catch((e) => notify("error", String(e)));
  }, []);
  useEffect(() => applyAppearance(settings), [settings]);
  useEffect(() => {
    api.setAppIcon(settings.appIcon).catch(() => {});
  }, [settings.appIcon]);

  return (
    <div className="app" onContextMenu={(e) => e.preventDefault()}>
      <TopBar />
      <div className="body">
        <RepoRail />
        {active && sidebarOpen && <Sidebar />}
        <main className={active ? "main" : "main empty"} style={{ "--detail-width": `${detailWidth}px` } as CSSProperties}>
          {active ? (
            <>
              <section className="center">
                {diff ? <DiffView target={diff} /> : <GraphTable />}
                {terminalOpen && <TerminalPane />}
              </section>
              {detailOpen && (
                <>
                  <DetailResizer />
                  <DetailPanel />
                </>
              )}
            </>
          ) : (
            <Welcome />
          )}
        </main>
      </div>
      <Palette />
      <SettingsDialog />
      <ProjectEditor />
      <ContextMenu />
      <DialogHost />
      <Toasts />
    </div>
  );
}
