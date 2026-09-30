import { Archive, CaretDown, CaretRight, Check, Folder, Funnel, GitBranch, Tag } from "@phosphor-icons/react";
import { MouseEvent, ReactNode, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Ref, Stash } from "../api";
import { actions, jumpTo, MenuItem, openMenu, useStore } from "../store";
import { refMenu } from "./GraphTable";

interface BranchNode {
  name: string;
  path: string;
  ref?: Ref;
  children: BranchNode[];
}

function branchTree(refs: Ref[], strip: (r: Ref) => string): BranchNode[] {
  const root: BranchNode = { name: "", path: "", children: [] };
  for (const ref of refs) {
    const parts = strip(ref).split("/");
    let node = root;
    parts.forEach((part, i) => {
      const leaf = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.name === part && !!c.ref === leaf);
      if (!child) {
        child = { name: part, path, children: [], ref: leaf ? ref : undefined };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sort = (nodes: BranchNode[]): BranchNode[] =>
    nodes
      .map((n) => ({ ...n, children: sort(n.children) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  return sort(root.children);
}

const leaves = (n: BranchNode): number => (n.ref ? 1 : n.children.reduce((s, c) => s + leaves(c), 0));

function stashMenu(s: Stash): MenuItem[] {
  return [
    { label: "Apply", run: () => actions.applyStash(s.index) },
    { label: "Pop", run: () => actions.pop(s.index) },
    { separator: true, label: "" },
    { label: "Drop…", run: () => actions.dropStash(s.index), danger: true },
  ];
}

function remoteMenu(name: string): MenuItem[] {
  return [
    { label: `Fetch ${name}`, run: () => actions.fetch(name) },
    { label: "Add remote…", run: actions.addRemote },
    { separator: true, label: "" },
    { label: `Remove ${name}…`, run: () => actions.removeRemote(name), danger: true },
  ];
}

const FOLDER_PAD = 6;
const LEAF_PAD = 10;
const INDENT = 14;

function Tree({ nodes, depth, collapsed, toggle, forceOpen, folderMenu }: { nodes: BranchNode[]; depth: number; collapsed: Set<string>; toggle: (p: string) => void; forceOpen: boolean; folderMenu?: (name: string) => MenuItem[] }) {
  return (
    <>
      {nodes.map((n) => {
        if (!n.ref) {
          const open = forceOpen || !collapsed.has(n.path);
          const menu = depth === 0 ? folderMenu?.(n.name) : undefined;
          return (
            <div key={"d:" + n.path}>
              <div
                className="side-item folder"
                style={{ paddingLeft: FOLDER_PAD + depth * INDENT }}
                onClick={() => toggle(n.path)}
                onContextMenu={(e) => {
                  if (!menu) return;
                  e.preventDefault();
                  openMenu(e.clientX, e.clientY, menu);
                }}
              >
                {open ? <CaretDown size={10} className="chev" /> : <CaretRight size={10} className="chev" />}
                <Folder size={13} className="icon" />
                <span className="label">{n.name}</span>
                <span className="count">{leaves(n)}</span>
              </div>
              {open && <Tree nodes={n.children} depth={depth + 1} collapsed={collapsed} toggle={toggle} forceOpen={forceOpen} />}
            </div>
          );
        }
        const ref = n.ref;
        const onMenu = (e: MouseEvent) => {
          e.preventDefault();
          openMenu(e.clientX, e.clientY, refMenu(ref));
        };
        const Icon = ref.isHead ? Check : ref.kind === "tag" ? Tag : GitBranch;
        return (
          <div
            key={"r:" + ref.name}
            className={`side-item${ref.isHead ? " current" : ""}`}
            style={{ paddingLeft: LEAF_PAD + depth * INDENT }}
            onClick={() => jumpTo(ref.sha)}
            onDoubleClick={() => (ref.kind === "tag" ? actions.checkout(ref.sha, "commit") : !ref.isHead && actions.checkout(ref.short, ref.kind === "remote" ? "remote" : "local"))}
            onContextMenu={onMenu}
            title={ref.short}
          >
            <Icon size={13} className="icon" />
            <span className="label">{n.name}</span>
            {(ref.ahead > 0 || ref.behind > 0) && (
              <span className="track">
                {ref.ahead > 0 && `↑${ref.ahead}`}
                {ref.behind > 0 && ` ↓${ref.behind}`}
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}

function Section({ id, title, count, children, open, onToggle, menu }: { id: string; title: string; count: number; children: ReactNode; open: boolean; onToggle: (id: string) => void; menu?: MenuItem[] }) {
  return (
    <div className="side-section">
      <div
        className="side-head"
        onClick={() => onToggle(id)}
        onContextMenu={(e) => {
          if (!menu) return;
          e.preventDefault();
          openMenu(e.clientX, e.clientY, menu);
        }}
      >
        <span>{title}</span>
        <span className="count">{count}</span>
        {open ? <CaretDown size={12} className="chev end" /> : <CaretRight size={12} className="chev end" />}
      </div>
      {open && children}
    </div>
  );
}

export function Sidebar() {
  const { snap, commits, hasMore } = useStore(useShallow((s) => ({ snap: s.snap, commits: s.commits, hasMore: s.hasMore })));
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Set<string>>(new Set(["remotes", "tags"]));

  const q = filter.trim().toLowerCase();
  const refs = useMemo(() => (snap?.refs ?? []).filter((r) => !q || r.short.toLowerCase().includes(q)), [snap?.refs, q]);
  const locals = useMemo(() => branchTree(refs.filter((r) => r.kind === "local"), (r) => r.short), [refs]);
  const remotes = useMemo(() => branchTree(refs.filter((r) => r.kind === "remote"), (r) => r.short), [refs]);
  const tags = useMemo(() => refs.filter((r) => r.kind === "tag").sort((a, b) => b.short.localeCompare(a.short, undefined, { numeric: true })), [refs]);
  const stashes = (snap?.stashes ?? []).filter((s) => !q || s.message.toLowerCase().includes(q));

  const toggleFolder = (key: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const toggleSection = (id: string) =>
    setClosed((c) => {
      const next = new Set(c);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const status = snap?.status;
  const localCount = refs.filter((r) => r.kind === "local").length;
  const remoteCount = refs.filter((r) => r.kind === "remote").length;

  return (
    <aside className="sidebar">
      <label className="filter">
        <Funnel size={13} />
        <input placeholder="Filter refs" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} />
      </label>
      <div className="side-scroll">
        <Section id="branches" title="Branches" count={localCount} open={!closed.has("branches")} onToggle={toggleSection}>
          <Tree nodes={locals} depth={0} collapsed={collapsed} toggle={(p) => toggleFolder("l:" + p)} forceOpen={!!q} />
        </Section>
        <Section id="remotes" title="Remotes" count={remoteCount} open={!closed.has("remotes") || !!q} onToggle={toggleSection} menu={[{ label: "Add remote…", run: actions.addRemote }]}>
          <Tree nodes={remotes} depth={0} collapsed={collapsed} toggle={(p) => toggleFolder("r:" + p)} forceOpen={!!q} folderMenu={remoteMenu} />
        </Section>
        <Section id="tags" title="Tags" count={tags.length} open={!closed.has("tags") || !!q} onToggle={toggleSection}>
          {tags.map((t) => (
            <div
              key={t.name}
              className="side-item"
              style={{ paddingLeft: LEAF_PAD }}
              onClick={() => jumpTo(t.sha)}
              onContextMenu={(e) => {
                e.preventDefault();
                openMenu(e.clientX, e.clientY, refMenu(t));
              }}
            >
              <Tag size={13} className="icon" />
              <span className="label">{t.short}</span>
            </div>
          ))}
        </Section>
        <Section id="stashes" title="Stashes" count={stashes.length} open={!closed.has("stashes")} onToggle={toggleSection}>
          {stashes.map((s) => (
            <div
              key={s.sha}
              className="side-item"
              style={{ paddingLeft: LEAF_PAD }}
              title={s.message}
              onDoubleClick={() => actions.applyStash(s.index)}
              onContextMenu={(e) => {
                e.preventDefault();
                openMenu(e.clientX, e.clientY, stashMenu(s));
              }}
            >
              <Archive size={13} className="icon" />
              <span className="label">{s.message}</span>
            </div>
          ))}
        </Section>
      </div>
      {status && (
        <div className="side-foot" onClick={() => status.head && jumpTo(status.head)}>
          <div className="foot-line">
            <GitBranch size={13} className="icon" />
            <span className="label">{status.branch ?? "detached HEAD"}</span>
            <span className="track foot-track">
              {status.ahead > 0 && <span><i>↑</i>{status.ahead}</span>}
              {status.behind > 0 && <span><i>↓</i>{status.behind}</span>}
            </span>
          </div>
          <div className="foot-sub">
            <span>{status.upstream ?? "no upstream"}</span>
            <span>
              {commits.length}
              {hasMore ? "+" : ""} commits
            </span>
          </div>
        </div>
      )}
    </aside>
  );
}
