import { Channel } from "@tauri-apps/api/core";
import { Archive, ArrowUUpLeft, CaretDown, CaretRight, Check, CircleNotch, Copy, Folder, GitCommit, Globe, Laptop, ListBullets, Minus, Plus, Sparkle, Tag, TreeView, X } from "@phosphor-icons/react";
import { MouseEvent, ReactNode, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { AiEvent, api, CommitDetail, FileChange, Ref } from "../api";
import { aiConfig } from "../ai";
import { WIP } from "../graph";
import { actions, DiffTarget, jumpTo, MenuItem, notify, openMenu, select, useStore } from "../store";
import { buildTree, dateParts, relativeTime, splitPath, TreeNode } from "../util";
import { Avatar } from "./Avatar";
import { ExplainCard, explainCommit } from "./Explain";

const NO_REFS: Ref[] = [];

export interface ListFile {
  path: string;
  origPath: string | null;
  status: string;
  additions?: number | null;
  deletions?: number | null;
  dim?: boolean;
}

const STATUS_LABEL: Record<string, string> = { M: "M", A: "A", D: "D", R: "R", C: "C", T: "T", U: "U", "?": "A" };
const STATUS_TITLE: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
  U: "Conflicted",
  "?": "Untracked",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`status s-${status === "?" ? "N" : status}`} title={STATUS_TITLE[status]}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

type Mode = "path" | "tree";

function useMode(): [Mode, (m: Mode) => void] {
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem("ahtapot.fileMode") as Mode) ?? "tree");
  return [
    mode,
    (m) => {
      setMode(m);
      try {
        localStorage.setItem("ahtapot.fileMode", m);
      } catch {
        /* storage unavailable */
      }
    },
  ];
}

function ModeToggle({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  return (
    <div className="seg">
      <button className={mode === "path" ? "on" : ""} onClick={() => setMode("path")}>
        <ListBullets size={12} /> Path
      </button>
      <button className={mode === "tree" ? "on" : ""} onClick={() => setMode("tree")}>
        <TreeView size={12} /> Tree
      </button>
    </div>
  );
}

interface FileListProps {
  files: ListFile[];
  mode: Mode;
  active?: string;
  onOpen: (f: ListFile) => void;
  actions?: (f: ListFile) => ReactNode;
  menu?: (f: ListFile) => MenuItem[];
}

function Counts({ f }: { f: ListFile }) {
  if (f.additions == null && f.deletions == null) return null;
  return (
    <span className="counts">
      {f.additions != null && <span className="add">+{f.additions}</span>}
      {f.deletions != null && <span className="del">-{f.deletions}</span>}
    </span>
  );
}

function FileRow({ f, depth, label, props }: { f: ListFile; depth: number; label: ReactNode; props: FileListProps }) {
  return (
    <div
      className={`file-row${props.active === f.path ? " active" : ""}${f.dim ? " dim" : ""}`}
      style={{ paddingLeft: 10 + depth * 14 }}
      onClick={() => !f.dim && props.onOpen(f)}
      onContextMenu={(e: MouseEvent) => {
        if (!props.menu) return;
        e.preventDefault();
        openMenu(e.clientX, e.clientY, props.menu(f));
      }}
      title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
    >
      {f.dim ? <span className="status s-none" /> : <StatusBadge status={f.status} />}
      <span className="file-name">{label}</span>
      <span className="row-actions">{props.actions?.(f)}</span>
      <Counts f={f} />
    </div>
  );
}

function TreeRows({ nodes, depth, byPath, props, collapsed, toggle }: { nodes: TreeNode[]; depth: number; byPath: Map<string, ListFile>; props: FileListProps; collapsed: Set<string>; toggle: (p: string) => void }) {
  return (
    <>
      {nodes.map((n) => {
        if (n.leaf) {
          const f = byPath.get(n.path)!;
          return <FileRow key={n.path} f={f} depth={depth} label={n.name} props={props} />;
        }
        const open = !collapsed.has(n.path);
        const changed = countChanged(n, byPath);
        return (
          <div key={n.path}>
            <div className="file-row folder" style={{ paddingLeft: 10 + depth * 14 }} onClick={() => toggle(n.path)}>
              {open ? <CaretDown size={8} className="chev" /> : <CaretRight size={8} className="chev" />}
              <Folder size={13} className="icon" />
              <span className="file-name">{n.name}</span>
              <span className="count">{changed}</span>
            </div>
            {open && <TreeRows nodes={n.children} depth={depth + 1} byPath={byPath} props={props} collapsed={collapsed} toggle={toggle} />}
          </div>
        );
      })}
    </>
  );
}

function countChanged(n: TreeNode, byPath: Map<string, ListFile>): number {
  if (n.leaf) return byPath.get(n.path)?.dim ? 0 : 1;
  return n.children.reduce((s, c) => s + countChanged(c, byPath), 0);
}

export function FileList(props: FileListProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const byPath = useMemo(() => new Map(props.files.map((f) => [f.path, f])), [props.files]);
  const tree = useMemo(() => (props.mode === "tree" ? buildTree(props.files.map((f) => f.path)) : []), [props.files, props.mode]);

  if (props.mode === "path") {
    return (
      <div className="file-list">
        {props.files.map((f) => {
          const [dir, name] = splitPath(f.path);
          return (
            <FileRow
              key={f.path}
              f={f}
              depth={0}
              props={props}
              label={
                <>
                  <span className="dir">{dir}</span>
                  {name}
                </>
              }
            />
          );
        })}
      </div>
    );
  }
  const toggle = (p: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      next.has(p) ? next.delete(p) : next.add(p);
      return next;
    });
  return (
    <div className="file-list">
      <TreeRows nodes={tree} depth={0} byPath={byPath} props={props} collapsed={collapsed} toggle={toggle} />
    </div>
  );
}

const SEP: MenuItem = { separator: true, label: "" };

function pathMenu(f: ListFile, deleted: boolean): MenuItem[] {
  return [
    { label: "Open in editor", run: () => actions.openInEditor(f.path), disabled: deleted },
    { label: "Reveal in Finder", run: () => actions.reveal(f.path), disabled: deleted },
    { label: "Copy path", run: () => actions.copy(f.path, "path") },
  ];
}

function summarize(files: ListFile[]) {
  const counts = new Map<string, number>();
  let add = 0;
  let del = 0;
  for (const f of files) {
    counts.set(f.status, (counts.get(f.status) ?? 0) + 1);
    add += f.additions ?? 0;
    del += f.deletions ?? 0;
  }
  const words: Record<string, string> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", T: "type changed" };
  const parts = [...counts].map(([s, n]) => ({ s, n, word: words[s] ?? s }));
  return { parts, add, del };
}

function CommitPanel({ detail }: { detail: CommitDetail }) {
  const { active, diff, refs, model } = useStore(
    useShallow((s) => ({ active: s.active!, diff: s.diff, refs: s.snap?.refs ?? NO_REFS, model: aiConfig(s.settings.ai).model })),
  );
  const [mode, setMode] = useMode();
  const [allFiles, setAllFiles] = useState(false);
  const [tree, setTree] = useState<string[] | null>(null);

  useEffect(() => {
    setTree(null);
    if (allFiles) api.treeFiles(active, detail.sha).then(setTree, (e) => notify("error", String(e)));
  }, [allFiles, detail.sha, active]);

  const changed: ListFile[] = detail.files;
  const files = useMemo(() => {
    if (!allFiles || !tree) return changed;
    const set = new Set(changed.map((f) => f.path));
    return [...changed, ...tree.filter((p) => !set.has(p)).map((p) => ({ path: p, origPath: null, status: "", dim: true }))];
  }, [allFiles, tree, changed]);

  const [subject, ...rest] = detail.message.split("\n");
  const body = rest.join("\n").trim();
  const summary = summarize(changed);
  const branchRefs = refs.filter((r) => r.sha === detail.sha);
  const openFile = (f: ListFile) =>
    useStore.setState({ diff: { kind: "commit", sha: detail.sha, path: f.path, origPath: f.origPath, status: f.status } });
  const activePath = diff?.kind === "commit" && diff.sha === detail.sha ? diff.path : undefined;
  const copy = actions.copy;

  return (
    <div className="detail">
      <div className="detail-head">
        <GitCommit size={13} className="icon" />
        <span className="title">Commit</span>
        <span className="sha-chip">{detail.sha.slice(0, 7)}</span>
        <span className="spacer" />
        <button className="icon-btn ai" title={model ? "Explain with AI" : "Explain with AI (choose a model in Settings)"} onClick={() => explainCommit(active, detail.sha)}>
          <Sparkle size={14} />
        </button>
        <button className="icon-btn" title="Checkout this commit" onClick={() => actions.checkout(detail.sha, "commit")}>
          <GitCommit size={13} />
        </button>
        <button className="icon-btn" title="Copy SHA" onClick={() => copy(detail.sha, "SHA")}>
          <Copy size={17} />
        </button>
        <button className="icon-btn close" title="Close" onClick={() => select(null)}>
          <X size={11} />
        </button>
      </div>
      <div className="detail-scroll">
        <div className="detail-section">
          {branchRefs.length > 0 && (
            <div className="detail-refs">
              {branchRefs.map((r) => {
                const Icon = r.isHead ? Check : r.kind === "tag" ? Tag : r.kind === "local" && !r.upstream ? Laptop : Globe;
                return (
                  <span key={r.name} className="pill plain" title={r.short}>
                    <Icon size={11} />
                    <span className="pill-label">{r.short}</span>
                  </span>
                );
              })}
            </div>
          )}
          <h2 className="subject">{subject}</h2>
          {body && <pre className="message-body">{body}</pre>}
          <ExplainCard sha={detail.sha} />
        </div>
        <div className="detail-section meta">
          <div className="author">
            <Avatar name={detail.author} email={detail.email} size={40} />
            <div>
              <div className="name">{detail.author}</div>
              <div className="email">{detail.email}</div>
              <div className="when">
                {[...dateParts(detail.authorTime), relativeTime(detail.authorTime)].map((part, i) => (
                  <span key={i}>{part}</span>
                ))}
              </div>
            </div>
          </div>
          <div className="kv">
            <span className="k">SHA</span>
            <span className="v mono">{detail.sha}</span>
            <button className="icon-btn small" title="Copy SHA" onClick={() => copy(detail.sha, "SHA")}>
              <Copy size={12} />
            </button>
            <span className="k">{detail.parents.length > 1 ? "Parents" : "Parent"}</span>
            <span className="v">
              {detail.parents.length === 0 && <span className="muted">none</span>}
              {detail.parents.map((p) => (
                <button key={p} className="link chip mono" onClick={() => jumpTo(p)}>
                  <GitCommit size={10} />
                  {p.slice(0, 7)}
                </button>
              ))}
            </span>
            <span />
            {detail.committer !== detail.author && (
              <>
                <span className="k">Committer</span>
                <span className="v">{detail.committer}</span>
                <span />
              </>
            )}
          </div>
        </div>
        <div className="detail-section files-head">
          <span className="title">Files</span>
          <span className="count">{changed.length}</span>
          <span className="spacer" />
          <label className="check small">
            <input type="checkbox" checked={allFiles} onChange={(e) => setAllFiles(e.target.checked)} />
            All files
          </label>
          <ModeToggle mode={mode} setMode={setMode} />
        </div>
        <div className="files-summary">
          <span className="parts">
            {summary.parts.map((p) => (
              <span key={p.s}>
                <span className={`s-text-${p.s}`}>{p.n}</span> {p.word}
              </span>
            ))}
          </span>
          <span className="counts">
            <span className="add">+{summary.add}</span>
            <span className="del">-{summary.del}</span>
          </span>
        </div>
        <FileList files={files} mode={mode} active={activePath} onOpen={openFile} menu={(f) => pathMenu(f, f.status === "D")} />
      </div>
    </div>
  );
}

function wipTarget(f: ListFile, staged: boolean): DiffTarget {
  return { kind: "wip", path: f.path, origPath: f.origPath, staged, untracked: f.status === "?", status: f.status };
}

const STATE_LABEL: Record<string, string> = {
  merging: "Merge in progress",
  rebasing: "Rebase in progress",
  "cherry-picking": "Cherry-pick in progress",
  reverting: "Revert in progress",
};

function ProgressBanner({ state, conflicts }: { state: string; conflicts: number }) {
  const busy = useStore((s) => s.busy);
  return (
    <div className="banner">
      <div className="banner-text">
        <strong>{STATE_LABEL[state] ?? state}</strong>
        <span>{conflicts ? `${conflicts} conflicted file${conflicts === 1 ? "" : "s"} left. Resolve each, then continue.` : "All conflicts are resolved. Continue to finish."}</span>
      </div>
      <div className="banner-actions">
        <button className="btn small" disabled={!!busy} onClick={() => actions.sequence("abort")}>
          Abort
        </button>
        {state !== "merging" && (
          <button className="btn small" disabled={!!busy} onClick={() => actions.sequence("skip")}>
            Skip
          </button>
        )}
        <button className="btn small primary" disabled={!!busy || conflicts > 0} onClick={() => actions.sequence("continue")}>
          Continue
        </button>
      </div>
    </div>
  );
}

function WipPanel() {
  const { snap, diff, busy, limit } = useStore(useShallow((s) => ({ snap: s.snap!, diff: s.diff, busy: s.busy, limit: s.settings.summaryLimit })));
  const [mode, setMode] = useMode();
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [amend, setAmend] = useState(false);
  const [generating, setGenerating] = useState(false);
  const { staged, unstaged, conflicted, state } = snap.status;

  const generate = () => {
    const { active, settings } = useStore.getState();
    if (!active) return;
    let text = "";
    const channel = new Channel<AiEvent>();
    channel.onmessage = (event) => {
      if (event.kind !== "text") return;
      text += event.data;
      const [first, ...rest] = text.replace(/^\s*```[^\n]*\n?/, "").replace(/\n?```\s*$/, "").split("\n");
      setSummary(first.trim());
      setDescription(rest.join("\n").trim());
    };
    setGenerating(true);
    api
      .aiCommitMessage(active, amend, limit, aiConfig(settings.ai), channel)
      .catch((e) => notify("error", String(e)))
      .finally(() => setGenerating(false));
  };

  const setAmendMode = async (on: boolean) => {
    setAmend(on);
    const repo = useStore.getState().active;
    if (on && !summary && snap.status.head && repo) {
      const message = await api.commitMessage(repo, "HEAD");
      const [first, ...rest] = message.split("\n");
      setSummary(first);
      setDescription(rest.join("\n").trim());
    }
  };

  const submit = async () => {
    const message = description.trim() ? `${summary.trim()}\n\n${description.trim()}` : summary.trim();
    const ok = await actions.commit(message, amend);
    if (ok) {
      setSummary("");
      setDescription("");
      setAmend(false);
    }
  };

  const open = (staged: boolean) => (f: ListFile) => useStore.setState({ diff: wipTarget(f, staged) });
  const activeStaged = diff?.kind === "wip" && diff.staged ? diff.path : undefined;
  const activeUnstaged = diff?.kind === "wip" && !diff.staged ? diff.path : undefined;
  const pathsOf = (files: FileChange[]) => files.flatMap((f) => (f.origPath ? [f.origPath, f.path] : [f.path]));
  const discard = (files: ListFile[]) =>
    actions.discard(
      files.filter((f) => f.status !== "?").map((f) => f.path),
      files.filter((f) => f.status === "?").map((f) => f.path),
    );
  const canCommit = !busy && summary.trim().length > 0 && (staged.length > 0 || amend) && conflicted.length === 0;
  const commitLabel = amend
    ? "Amend previous commit"
    : state === "merging"
      ? "Commit merge"
      : `Commit changes to ${staged.length} file${staged.length === 1 ? "" : "s"}`;

  const unstagedMenu = (f: ListFile): MenuItem[] => [
    { label: "Stage", run: () => actions.stage([f.path]) },
    { label: "Discard changes…", run: () => discard([f]), danger: true },
    SEP,
    ...pathMenu(f, f.status === "D"),
  ];
  const stagedMenu = (f: ListFile): MenuItem[] => [
    { label: "Unstage", run: () => actions.unstage(f.origPath ? [f.origPath, f.path] : [f.path]) },
    SEP,
    ...pathMenu(f, f.status === "D"),
  ];
  const conflictMenu = (f: ListFile): MenuItem[] => [
    { label: "Resolve…", run: () => open(false)(f) },
    { label: "Keep HEAD version", run: () => actions.resolve(f.path, "ours") },
    { label: "Keep incoming version", run: () => actions.resolve(f.path, "theirs") },
    { label: "Mark resolved", run: () => actions.stage([f.path]) },
    SEP,
    ...pathMenu(f, false),
  ];

  return (
    <div className="detail">
      <div className="detail-head">
        <span className="title">Uncommitted changes</span>
        <span className="count">{new Set([...staged, ...unstaged, ...conflicted].map((f) => f.path)).size}</span>
        <span className="spacer" />
        <button className="icon-btn" title="Stash changes" onClick={() => actions.stash()}>
          <Archive size={14} />
        </button>
        <ModeToggle mode={mode} setMode={setMode} />
      </div>
      <div className="detail-scroll wip">
        {state && <ProgressBanner state={state} conflicts={conflicted.length} />}
        {conflicted.length > 0 && (
          <>
            <div className="list-head">
              <span>Conflicted</span>
              <span className="count">{conflicted.length}</span>
            </div>
            <FileList
              files={conflicted}
              mode={mode}
              active={activeUnstaged}
              onOpen={open(false)}
              menu={conflictMenu}
              actions={(f) => <IconAction title="Mark resolved" onClick={() => actions.stage([f.path])} icon={<Check size={13} />} />}
            />
          </>
        )}
        <div className="list-head">
          <span>Staged files</span>
          <span className="count">{staged.length}</span>
          <span className="spacer" />
          {staged.length > 0 && (
            <button className="btn small" onClick={() => actions.unstage(pathsOf(staged))}>
              Unstage all
            </button>
          )}
        </div>
        <FileList
          files={staged}
          mode={mode}
          active={activeStaged}
          onOpen={open(true)}
          menu={stagedMenu}
          actions={(f) => <IconAction title="Unstage" onClick={() => actions.unstage(f.origPath ? [f.origPath, f.path] : [f.path])} icon={<Minus size={13} />} />}
        />
        {staged.length === 0 && <div className="list-empty">Stage files to commit them</div>}
        <div className="list-head">
          <span>Unstaged files</span>
          <span className="count">{unstaged.length}</span>
          <span className="spacer" />
          {unstaged.length > 0 && (
            <button className="btn small" onClick={() => actions.stage(unstaged.map((f) => f.path))}>
              Stage all
            </button>
          )}
        </div>
        <FileList
          files={unstaged}
          mode={mode}
          active={activeUnstaged}
          onOpen={open(false)}
          menu={unstagedMenu}
          actions={(f) => (
            <>
              <IconAction title="Discard changes" onClick={() => discard([f])} icon={<ArrowUUpLeft size={13} />} />
              <IconAction title="Stage" onClick={() => actions.stage([f.path])} icon={<Plus size={13} />} />
            </>
          )}
        />
        {unstaged.length === 0 && <div className="list-empty">No unstaged changes</div>}
      </div>
      <form
        className="commit-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (canCommit) submit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.metaKey && canCommit) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <div className="summary-field">
          <textarea
            className="field"
            rows={1}
            placeholder="Commit summary"
            value={summary}
            onChange={(e) => setSummary(e.target.value.replace(/\n/g, " "))}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.metaKey) return;
              e.preventDefault();
              e.currentTarget.form?.querySelector<HTMLTextAreaElement>("textarea.description")?.focus();
            }}
          />
          <button
            type="button"
            className="icon-btn small ai"
            title={staged.length || amend ? "Write the message with AI" : "Stage changes to write the message with AI"}
            disabled={generating || (!staged.length && !amend)}
            onClick={generate}
          >
            {generating ? <CircleNotch size={13} className="spin" /> : <Sparkle size={13} />}
          </button>
          <span className={`limit${summary.length > limit ? " over" : ""}`}>{limit - summary.length}</span>
        </div>
        <textarea className="field description" placeholder="Description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        <label className="check small">
          <input type="checkbox" checked={amend} onChange={(e) => setAmendMode(e.target.checked)} disabled={!snap.status.head || !!state} />
          Amend previous commit
        </label>
        <button type="submit" className="btn primary block" disabled={!canCommit}>
          {commitLabel}
          <kbd>⌘↵</kbd>
        </button>
      </form>
    </div>
  );
}

function IconAction({ title, onClick, icon }: { title: string; onClick: () => void; icon: ReactNode }) {
  return (
    <button
      className="icon-btn tiny"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {icon}
    </button>
  );
}

export function DetailPanel() {
  const { selected, detail, snap } = useStore(useShallow((s) => ({ selected: s.selected, detail: s.detail, snap: s.snap })));
  if (selected === WIP && snap) return <WipPanel />;
  if (detail && detail.sha === selected) return <CommitPanel detail={detail} />;
  return (
    <div className="detail">
      <div className="detail-empty">{selected ? "Loading…" : "Select a commit"}</div>
    </div>
  );
}
