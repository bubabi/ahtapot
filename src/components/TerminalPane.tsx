import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ArrowClockwise, CaretDoubleDown, CaretDoubleUp, TerminalWindow, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api, PtyEvent } from "../api";
import { monoStack } from "../settings";
import { useStore } from "../store";
import { tildify } from "../util";

interface Session {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  id: number | null;
  exited: boolean;
  onExit?: () => void;
}

const sessions = new Map<string, Session>();

const THEME = {
  background: "#00000000",
  foreground: "#d7dae0",
  cursor: "#d7dae0",
  selectionBackground: "#3b4a6b",
  black: "#1c1f26",
  red: "#ff6b6b",
  green: "#5fd38d",
  yellow: "#f2c55c",
  blue: "#5aa2ff",
  magenta: "#c38bff",
  cyan: "#4fd6e6",
  white: "#d7dae0",
  brightBlack: "#5c6370",
  brightRed: "#ff8787",
  brightGreen: "#7ee2a8",
  brightYellow: "#ffd580",
  brightBlue: "#7cb6ff",
  brightMagenta: "#d4a8ff",
  brightCyan: "#7ee6f0",
  brightWhite: "#ffffff",
};

async function start(session: Session, cwd: string) {
  const channel = new Channel<PtyEvent>();
  channel.onmessage = (event) => {
    if (event.kind === "data") session.term.write(event.data);
    else {
      session.exited = true;
      session.id = null;
      session.term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
      session.onExit?.();
    }
  };
  session.exited = false;
  session.id = await api.ptySpawn(cwd, useStore.getState().settings.shell, session.term.cols, session.term.rows, channel);
}

function sessionFor(repo: string): Session {
  let session = sessions.get(repo);
  if (session) return session;
  const settings = useStore.getState().settings;
  const term = new Terminal({
    allowTransparency: true,
    cursorBlink: true,
    cursorStyle: settings.termCursor,
    fontFamily: monoStack(settings),
    fontSize: settings.termFontSize,
    lineHeight: 1.15,
    theme: THEME,
    scrollback: 5000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const el = document.createElement("div");
  el.className = "term-host";
  session = { term, fit, el, id: null, exited: false };
  const s = session;
  term.onData((data) => s.id != null && api.ptyWrite(s.id, data));
  term.onResize(({ cols, rows }) => s.id != null && api.ptyResize(s.id, cols, rows));
  sessions.set(repo, session);
  return session;
}

export function applyTerminalSettings() {
  const settings = useStore.getState().settings;
  for (const session of sessions.values()) {
    session.term.options.fontSize = settings.termFontSize;
    session.term.options.fontFamily = monoStack(settings);
    session.term.options.cursorStyle = settings.termCursor;
    session.fit.fit();
  }
}

export function closeTerminal(repo: string) {
  const session = sessions.get(repo);
  if (!session) return;
  if (session.id != null) api.ptyKill(session.id);
  session.term.dispose();
  session.el.remove();
  sessions.delete(repo);
}

export function TerminalPane() {
  const { active, env } = useStore(useShallow((s) => ({ active: s.active!, env: s.env })));
  const host = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(() => Number(localStorage.getItem("ahtapot.termHeight")) || 140);
  const [collapsed, setCollapsed] = useState(false);
  const [size, setSize] = useState({ cols: 0, rows: 0 });
  const [exited, setExited] = useState(false);

  useEffect(() => {
    const container = host.current;
    if (!container || collapsed) return;
    const session = sessionFor(active);
    container.appendChild(session.el);
    if (!session.term.element) session.term.open(session.el);
    session.fit.fit();
    setSize({ cols: session.term.cols, rows: session.term.rows });
    if (session.id == null && !session.exited) start(session, active);
    session.term.focus();

    const sizeSub = session.term.onResize(({ cols, rows }) => setSize({ cols, rows }));
    setExited(session.exited);
    session.onExit = () => setExited(true);
    const observer = new ResizeObserver(() => session.fit.fit());
    observer.observe(container);
    return () => {
      observer.disconnect();
      sizeSub.dispose();
      session.onExit = undefined;
      session.el.remove();
    };
  }, [active, collapsed]);

  const drag = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const initial = height;
    let latest = height;
    const move = (ev: PointerEvent) => {
      latest = Math.max(90, Math.min(window.innerHeight - 240, initial - (ev.clientY - startY)));
      setHeight(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        localStorage.setItem("ahtapot.termHeight", String(latest));
      } catch {
        /* storage unavailable */
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const restart = () => {
    const session = sessions.get(active);
    if (!session) return;
    session.term.reset();
    start(session, active);
    setExited(false);
  };

  const close = () => {
    closeTerminal(active);
    useStore.setState({ terminalOpen: false });
  };

  const title = env ? `${env.user}@${env.host}:${tildify(active, env.home)}` : active;

  return (
    <div className={`terminal${collapsed ? " collapsed" : ""}`} style={{ height: collapsed ? undefined : height }}>
      {!collapsed && <div className="term-drag" onPointerDown={drag} />}
      <div className="term-head">
        <TerminalWindow size={14} className="icon" />
        <span className="term-title">{title}</span>
        <span className="spacer" />
        {exited && (
          <button className="icon-btn" title="Restart shell" onClick={restart}>
            <ArrowClockwise size={13} />
          </button>
        )}
        <span className="term-size">
          {size.cols} × {size.rows}
        </span>
        <button className="icon-btn" title={collapsed ? "Expand" : "Collapse"} onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? <CaretDoubleUp size={14} /> : <CaretDoubleDown size={14} />}
        </button>
        <button className="icon-btn" title="Close terminal" onClick={close}>
          <X size={14} />
        </button>
      </div>
      {!collapsed && <div className="term-body" ref={host} />}
    </div>
  );
}
