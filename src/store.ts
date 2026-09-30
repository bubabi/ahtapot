import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { create } from "zustand";
import { api, Commit, CommitDetail, DiffOpts, EnvInfo, FileChange, PullMode, ResetMode, SequenceAction, Snapshot } from "./api";
import { closeTerminal } from "./components/TerminalPane";
import { WIP } from "./graph";
import { cachedSettings, normalize, Settings } from "./settings";

const PAGE = 1500;

export type DiffTarget =
  | { kind: "commit"; sha: string; path: string; origPath: string | null; status: string }
  | { kind: "wip"; path: string; origPath: string | null; staged: boolean; untracked: boolean; status: string };

export interface Note {
  id: number;
  kind: "ok" | "error" | "info";
  text: string;
  time: number;
}

export interface MenuItem {
  label: string;
  run?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

export interface PromptResult {
  value: string;
  check: boolean;
  extra: string;
}

export type Dialog =
  | {
      kind: "prompt";
      title: string;
      label: string;
      value: string;
      confirm: string;
      check?: { label: string; value: boolean };
      extra?: { label: string; placeholder?: string };
      noInput?: boolean;
      resolve: (v: PromptResult | null) => void;
    }
  | { kind: "confirm"; title: string; body: string; confirm: string; danger?: boolean; resolve: (ok: boolean) => void };

interface State {
  env: EnvInfo | null;
  repos: string[];
  active: string | null;
  badges: Record<string, number>;
  snap: Snapshot | null;
  commits: Commit[];
  hasMore: boolean;
  selected: string | null;
  detail: CommitDetail | null;
  diff: DiffTarget | null;
  sidebarOpen: boolean;
  terminalOpen: boolean;
  detailOpen: boolean;
  detailWidth: number;
  autoHidden: { sidebar: boolean; detail: boolean };
  paletteOpen: boolean;
  settingsOpen: boolean;
  busy: string | null;
  notes: Note[];
  toasts: Note[];
  menu: { x: number; y: number; items: MenuItem[]; anchor?: Element } | null;
  dialog: Dialog | null;
  settings: Settings;
  jump: { sha: string } | null;
}

export const DETAIL_WIDTH = 358;
export const clampDetailWidth = (w: number) => Math.round(Math.min(720, Math.max(280, w)));

function savedDetailWidth(): number {
  try {
    const w = Number(localStorage.getItem("ahtapot.detailWidth"));
    return w ? clampDetailWidth(w) : DETAIL_WIDTH;
  } catch {
    return DETAIL_WIDTH;
  }
}

export function saveDetailWidth(width: number) {
  try {
    localStorage.setItem("ahtapot.detailWidth", String(width));
  } catch {
    /* storage unavailable */
  }
}

export const useStore = create<State>(() => ({
  env: null,
  repos: [],
  active: null,
  badges: {},
  snap: null,
  commits: [],
  hasMore: false,
  selected: null,
  detail: null,
  diff: null,
  sidebarOpen: true,
  terminalOpen: false,
  detailOpen: true,
  detailWidth: savedDetailWidth(),
  autoHidden: { sidebar: false, detail: false },
  paletteOpen: false,
  settingsOpen: false,
  busy: null,
  notes: [],
  toasts: [],
  menu: null,
  dialog: null,
  settings: cachedSettings(),
  jump: null,
}));

const set = useStore.setState;
const get = useStore.getState;

let noteId = 0;

export function notify(kind: Note["kind"], text: string, toast = true) {
  const note = { id: ++noteId, kind, text, time: Date.now() / 1000 };
  set((s) => ({ notes: [note, ...s.notes].slice(0, 50), toasts: toast ? [...s.toasts, note] : s.toasts }));
  if (toast) setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== note.id) })), kind === "error" ? 8000 : 3500);
}

export function changeCount(snap: Snapshot | null): number {
  if (!snap) return 0;
  const paths = new Set<string>();
  for (const f of [...snap.status.staged, ...snap.status.unstaged, ...snap.status.conflicted]) paths.add(f.path);
  return paths.size;
}

function refsKey(snap: Snapshot): string {
  return snap.status.head + "|" + snap.refs.map((r) => r.name + r.sha).join(",");
}

function saveRepos() {
  const { repos, active } = get();
  api.reposSave({ repos, active }).catch(() => {});
}

export function updateSettings(patch: Partial<Settings>) {
  const settings = { ...get().settings, ...patch };
  set({ settings });
  try {
    localStorage.setItem("ahtapot.settings", JSON.stringify(settings));
  } catch {
    /* storage unavailable */
  }
  api.settingsSave(settings).catch((e) => notify("error", `Could not save settings: ${e}`));
  if ("autoFetchMinutes" in patch) scheduleAutoFetch();
}

export const diffOpts = (): DiffOpts => {
  const { ignoreWhitespace, contextLines } = get().settings;
  return { ignoreWhitespace, context: contextLines };
};

let loadToken = 0;
let lastRefsKey = "";

export async function init() {
  const [env, list, stored] = await Promise.all([api.envInfo(), api.reposLoad(), api.settingsLoad().catch(() => null)]);
  if (stored) set({ settings: normalize(stored) });
  else api.settingsSave(get().settings).catch(() => {});
  set({ env, repos: list.repos });
  if (!env.gitVersion) notify("error", "git was not found on your PATH. Install the Xcode command line tools or git, then restart Ahtapot.");
  listen<{ path: string; refs: boolean }>("repo-changed", (e) => {
    if (e.payload.path === get().active) refresh(e.payload.refs);
  });
  window.addEventListener("focus", () => refreshBadges());
  scheduleAutoFetch();
  if (env.launchRepo) await addRepo(env.launchRepo);
  else if (get().settings.restoreLastRepo && list.active && list.repos.includes(list.active)) await openRepo(list.active);
  refreshBadges();
}

let badgesAt = 0;
async function refreshBadges() {
  if (Date.now() - badgesAt < 5000) return;
  badgesAt = Date.now();
  for (const repo of get().repos) {
    if (repo === get().active) continue;
    try {
      const n = await api.changeCount(repo);
      set((s) => ({ badges: { ...s.badges, [repo]: n } }));
    } catch {
      /* a moved or deleted repository keeps its old badge */
    }
  }
}

let fetchTimer: number | undefined;
function scheduleAutoFetch() {
  window.clearInterval(fetchTimer);
  const minutes = get().settings.autoFetchMinutes;
  if (minutes > 0) fetchTimer = window.setInterval(backgroundFetch, minutes * 60_000);
}

async function backgroundFetch() {
  const { active, busy, snap, settings } = get();
  if (!active || busy || !snap?.remotes.length) return;
  try {
    await api.fetch(active, null, settings.fetchPrune);
    if (get().active === active) refresh();
  } catch (e) {
    notify("error", `Background fetch failed: ${e}`, false);
  }
}

export async function pickRepo() {
  const path = await openDialog({ directory: true, multiple: false, title: "Open repository" });
  if (typeof path === "string") await addRepo(path);
}

export async function addRepo(path: string) {
  try {
    const root = await api.repoResolve(path);
    if (!get().repos.includes(root)) set((s) => ({ repos: [...s.repos, root] }));
    await openRepo(root);
  } catch (e) {
    notify("error", String(e));
  }
}

export function removeRepo(path: string) {
  closeTerminal(path);
  const repos = get().repos.filter((r) => r !== path);
  set({ repos });
  if (get().active === path) {
    if (repos.length) openRepo(repos[0]);
    else set({ active: null, snap: null, commits: [], selected: null, detail: null, diff: null });
  }
  saveRepos();
}

export async function openRepo(path: string) {
  loadToken++;
  lastRefsKey = "";
  set({ active: path, snap: null, commits: [], selected: null, detail: null, diff: null, hasMore: false });
  saveRepos();
  api.watchRepo(path).catch((e) => notify("error", `Watcher: ${e}`));
  await refresh(true);
  const { snap, commits } = get();
  if (!get().selected) select(changeCount(snap) > 0 ? WIP : (snap?.status.head ?? commits[0]?.sha ?? null));
  if (get().settings.autoFetchMinutes > 0) backgroundFetch();
}

export async function refresh(full = false) {
  const repo = get().active;
  if (!repo) return;
  const token = loadToken;
  try {
    const snap = await api.snapshot(repo);
    if (token !== loadToken) return;
    set((s) => ({ snap, badges: { ...s.badges, [repo]: changeCount(snap) } }));
    const key = refsKey(snap);
    if (full || key !== lastRefsKey) {
      lastRefsKey = key;
      const limit = Math.max(PAGE, get().commits.length);
      const commits = await api.log(repo, 0, limit);
      if (token !== loadToken) return;
      set({ commits, hasMore: commits.length === limit });
    }
    const { selected, diff } = get();
    if (diff?.kind === "wip") {
      const { staged, unstaged, conflicted } = snap.status;
      const find = (list: FileChange[]) => list.find((f) => f.path === diff.path);
      const here = find(diff.staged ? staged : [...unstaged, ...conflicted]);
      if (here) {
        if (here.status !== diff.status) set({ diff: { ...diff, status: here.status } });
      } else {
        const moved = find(diff.staged ? unstaged : staged);
        set({ diff: moved ? { ...diff, staged: !diff.staged, untracked: moved.status === "?", status: moved.status } : null });
      }
    }
    if (selected === WIP && changeCount(snap) === 0 && !snap.status.state && !get().diff) select(snap.status.head);
  } catch (e) {
    notify("error", String(e));
  }
}

let loadingMore = false;
export async function loadMore(until = 0) {
  const { active, commits, hasMore } = get();
  if (!active || !hasMore || loadingMore) return;
  loadingMore = true;
  const token = loadToken;
  const want = Math.max(PAGE, until - commits.length + PAGE);
  try {
    const more = await api.log(active, commits.length, want);
    if (token === loadToken) set((s) => ({ commits: [...s.commits, ...more], hasMore: more.length === want }));
  } finally {
    loadingMore = false;
  }
}

const detailCache = new Map<string, CommitDetail>();

export async function select(sha: string | null) {
  set({ selected: sha, detail: sha && sha !== WIP ? (detailCache.get(sha) ?? null) : null });
  if (!sha || sha === WIP || detailCache.has(sha)) return;
  const repo = get().active!;
  try {
    const detail = await api.commitDetail(repo, sha);
    detailCache.set(sha, detail);
    if (get().selected === sha) set({ detail });
  } catch (e) {
    notify("error", String(e));
  }
}

/** Selects `sha` and scrolls to it, loading older history first when needed. */
export async function jumpTo(sha: string) {
  const repo = get().active;
  if (!repo) return;
  if (!get().commits.some((c) => c.sha === sha)) {
    const position = await api.logPosition(repo, sha).catch(() => null);
    if (position == null) return notify("info", `${sha.slice(0, 7)} is not reachable from any branch or tag`);
    set({ busy: "Loading history" });
    try {
      await loadMore(position + 1);
    } finally {
      set({ busy: null });
    }
    if (!get().commits.some((c) => c.sha === sha)) return;
  }
  set({ diff: null, jump: { sha } });
  select(sha);
}

export async function run(label: string, fn: (repo: string) => Promise<unknown>, success?: string) {
  const repo = get().active;
  if (!repo) return false;
  const busy = get().busy;
  if (busy) {
    notify("info", `Wait for "${busy}" to finish`);
    return false;
  }
  set({ busy: label });
  try {
    await fn(repo);
    if (success) notify("ok", success);
    return true;
  } catch (e) {
    notify("error", String(e));
    return false;
  } finally {
    set({ busy: null });
    await refresh();
    const status = get().snap?.status;
    if (status?.state && status.conflicted.length) select(WIP);
  }
}

export function prompt(
  title: string,
  label: string,
  confirm: string,
  value = "",
  check?: { label: string; value: boolean },
  extra?: { label: string; placeholder?: string },
) {
  return new Promise<PromptResult | null>((resolve) => {
    set({ dialog: { kind: "prompt", title, label, value, confirm, check, extra, resolve } });
  });
}

/** A confirmation with one checkbox. Resolves to the checkbox value, or null when cancelled. */
function confirmWithOption(title: string, body: string, confirm: string, check: { label: string; value: boolean }) {
  return new Promise<boolean | null>((resolve) => {
    set({
      dialog: { kind: "prompt", title, label: body, value: "", confirm, check, noInput: true, resolve: (r) => resolve(r ? r.check : null) },
    });
  });
}

export function confirmDialog(title: string, body: string, confirm: string, danger = false) {
  return new Promise<boolean>((resolve) => {
    set({ dialog: { kind: "confirm", title, body, confirm, danger, resolve } });
  });
}

export const openMenu = (x: number, y: number, items: MenuItem[]) => set({ menu: { x, y, items } });

/** Opens a menu below `anchor`, or closes it when `anchor` already owns the open menu. */
export function toggleMenu(anchor: Element, items: MenuItem[]) {
  if (get().menu?.anchor === anchor) return set({ menu: null });
  const r = anchor.getBoundingClientRect();
  set({ menu: { x: r.left, y: r.bottom + 6, items, anchor } });
}

const short = (sha: string) => sha.slice(0, 7);
const currentName = () => get().snap?.status.branch ?? "HEAD";

export const actions = {
  fetch: (remote: string | null = null) =>
    run("Fetching", (r) => api.fetch(r, remote, get().settings.fetchPrune), remote ? `Fetched ${remote}` : "Fetched all remotes"),
  pull: (mode: PullMode = get().settings.pullMode) => run("Pulling", (r) => api.pull(r, mode), "Pulled"),
  async push(force = false, branch: string | null = null) {
    if (force) {
      const name = branch ?? currentName();
      const ok = await confirmDialog("Force push", `Overwrite the remote copy of ${name}? --force-with-lease refuses if someone else pushed since your last fetch.`, "Force push", true);
      if (!ok) return;
    }
    await run("Pushing", (r) => api.push(r, force, branch), branch ? `Pushed ${branch}` : "Pushed");
  },
  undo: () =>
    run("Undoing", async (r) => {
      const label = await api.undo(r);
      notify("ok", `Undid ${label}`);
    }),
  redo: () =>
    run("Redoing", async (r) => {
      const label = await api.redo(r);
      notify("ok", `Redid ${label}`);
    }),
  checkout: (target: string, kind: "local" | "remote" | "commit") =>
    run("Checking out", (r) => api.checkout(r, target, kind), `Checked out ${kind === "commit" ? short(target) : target}`),
  async createBranch(start?: string) {
    const from = start ?? get().snap?.status.head;
    if (!from) return notify("error", "No commit to branch from");
    const result = await prompt("Create branch", `Starting at ${short(from)}`, "Create branch", "", {
      label: "Check out after creating",
      value: true,
    });
    const name = result?.value.trim();
    if (!result || !name) return;
    await run("Creating branch", (r) => api.createBranch(r, name, from, result.check), `Created ${name}`);
  },
  async renameBranch(from: string) {
    const result = await prompt("Rename branch", `New name for ${from}`, "Rename", from);
    const to = result?.value.trim();
    if (!to || to === from) return;
    await run("Renaming branch", (r) => api.renameBranch(r, from, to), `Renamed ${from} to ${to}`);
  },
  async deleteBranch(name: string) {
    const ok = await confirmDialog("Delete branch", `Delete local branch "${name}"? Undo restores it.`, "Delete", true);
    if (!ok) return;
    await run("Deleting branch", (r) => api.deleteBranch(r, name, true), `Deleted ${name}`);
  },
  async deleteRemoteBranch(target: string) {
    const ok = await confirmDialog("Delete remote branch", `Delete ${target} on the server? Undo cannot restore a remote branch.`, "Delete", true);
    if (ok) await run("Deleting remote branch", (r) => api.deleteRemoteBranch(r, target), `Deleted ${target}`);
  },
  async merge(target: string) {
    const noFf = await confirmWithOption("Merge", `Merge ${target} into ${currentName()}? Undo moves ${currentName()} back.`, "Merge", {
      label: "Always create a merge commit (--no-ff)",
      value: false,
    });
    if (noFf === null) return;
    await run("Merging", (r) => api.merge(r, target, noFf), `Merged ${target}`);
  },
  async rebase(onto: string) {
    const ok = await confirmDialog("Rebase", `Replay the commits of ${currentName()} on top of ${onto}? Undo moves the branch back.`, "Rebase");
    if (ok) await run("Rebasing", (r) => api.rebase(r, onto), `Rebased onto ${onto}`);
  },
  cherryPick: (sha: string) => run("Cherry-picking", (r) => api.cherryPick(r, sha), `Cherry-picked ${short(sha)}`),
  revert: (sha: string) => run("Reverting", (r) => api.revert(r, sha), `Reverted ${short(sha)}`),
  async reset(sha: string, mode: ResetMode) {
    const effect = {
      soft: "Keeps your changes staged.",
      mixed: "Keeps your changes, unstaged.",
      hard: "Discards uncommitted changes. They are saved as a stash first.",
    }[mode];
    const ok = await confirmDialog(`Reset (${mode})`, `Move ${currentName()} to ${short(sha)}? ${effect}`, "Reset", mode === "hard");
    if (ok) await run("Resetting", (r) => api.reset(r, sha, mode), `Reset to ${short(sha)}`);
  },
  sequence: (action: SequenceAction) => {
    const verb = { continue: "Continuing", abort: "Aborting", skip: "Skipping" }[action];
    return run(verb, (r) => api.sequence(r, action), { continue: "Continued", abort: "Aborted", skip: "Skipped commit" }[action]);
  },
  resolve: (path: string, side: "ours" | "theirs") =>
    run("Resolving", (r) => api.resolve(r, path, side), `Kept ${side === "ours" ? "HEAD" : "incoming"} version of ${path}`),
  async createTag(sha: string) {
    const result = await prompt("Create tag", `Tag ${short(sha)}`, "Create tag", "", undefined, {
      label: "Message (optional, makes an annotated tag)",
    });
    const name = result?.value.trim();
    if (!result || !name) return;
    await run("Creating tag", (r) => api.createTag(r, name, sha, result.extra), `Created tag ${name}`);
  },
  async deleteTag(name: string) {
    const ok = await confirmDialog("Delete tag", `Delete local tag "${name}"? Undo restores it.`, "Delete", true);
    if (ok) await run("Deleting tag", (r) => api.deleteTag(r, name), `Deleted tag ${name}`);
  },
  pushTag: (name: string) => run("Pushing tag", (r) => api.pushTag(r, name), `Pushed tag ${name}`),
  async addRemote() {
    const result = await prompt("Add remote", "Name", "Add remote", get().snap?.remotes.length ? "" : "origin", undefined, {
      label: "URL",
      placeholder: "git@github.com:owner/repo.git",
    });
    const name = result?.value.trim();
    const url = result?.extra.trim();
    if (!name || !url) return;
    if (await run("Adding remote", (r) => api.remoteAdd(r, name, url), `Added ${name}`)) actions.fetch(name);
  },
  async removeRemote(name: string) {
    const ok = await confirmDialog("Remove remote", `Remove ${name} and its remote-tracking branches?`, "Remove", true);
    if (ok) await run("Removing remote", (r) => api.remoteRemove(r, name), `Removed ${name}`);
  },
  async stash() {
    const result = await prompt("Stash changes", "Message (optional)", "Stash", "", { label: "Include untracked files", value: true });
    if (!result) return;
    await run("Stashing", (r) => api.stashPush(r, result.value, result.check), "Stashed changes");
  },
  pop: (index = 0) => run("Popping stash", (r) => api.stashApply(r, true, index), `Popped stash@{${index}}`),
  applyStash: (index: number) => run("Applying stash", (r) => api.stashApply(r, false, index), `Applied stash@{${index}}`),
  async dropStash(index: number) {
    const ok = await confirmDialog("Drop stash", `Drop stash@{${index}}? Undo restores it.`, "Drop", true);
    if (ok) await run("Dropping stash", (r) => api.stashDrop(r, index), `Dropped stash@{${index}}`);
  },
  stage: (paths: string[]) => run("Staging", (r) => api.stage(r, paths)),
  unstage: (paths: string[]) => run("Unstaging", (r) => api.unstage(r, paths)),
  async discard(tracked: string[], untracked: string[]) {
    const n = tracked.length + untracked.length;
    if (get().settings.confirmDiscard) {
      const files = n === 1 ? (tracked[0] ?? untracked[0]) : `${n} files`;
      const ok = await confirmDialog("Discard changes", `Discard changes in ${files}? Undo (⌘Z) restores them.`, "Discard", true);
      if (!ok) return;
    }
    await run("Discarding", (r) => api.discard(r, tracked, untracked), "Discarded changes");
  },
  applyPatch: (patch: string, reverse: boolean) => run(reverse ? "Unstaging" : "Staging", (r) => api.applyPatch(r, patch, reverse)),
  discardPatch: (patch: string, path: string) => run("Discarding", (r) => api.applyWorktree(r, patch, true, path)),
  commit: (message: string, amend: boolean) =>
    run(
      amend ? "Amending" : "Committing",
      (r) => api.commit(r, message, amend, get().settings.signCommits),
      amend ? "Amended commit" : "Committed",
    ),
  async openInEditor(path: string | null = null) {
    const repo = get().active;
    if (!repo) return;
    await api.openPath(repo, path, get().settings.editor, false).catch((e) => notify("error", String(e)));
  },
  async reveal(path: string | null = null) {
    const repo = get().active;
    if (!repo) return;
    await api.openPath(repo, path, "", true).catch((e) => notify("error", String(e)));
  },
  copy: (text: string, what: string) => navigator.clipboard.writeText(text).then(() => notify("info", `Copied ${what}`)),
  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen, autoHidden: { ...s.autoHidden, sidebar: false } })),
  toggleDetail: () => set((s) => ({ detailOpen: !s.detailOpen, autoHidden: { ...s.autoHidden, detail: false } })),
  openPalette: () => set({ paletteOpen: true }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  openSettings: () => set({ settingsOpen: true, paletteOpen: false }),
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen, paletteOpen: false })),
  zoom: (step: number) => {
    const zoom = step === 0 ? 1 : Math.round(Math.min(1.5, Math.max(0.75, get().settings.zoom + step)) * 100) / 100;
    updateSettings({ zoom });
  },
};

export function handleMenu(id: string) {
  const active = get().active;
  const snap = get().snap;
  const byId: Record<string, () => unknown> = {
    settings: actions.toggleSettings,
    open: pickRepo,
    reveal: () => actions.reveal(),
    editor: () => actions.openInEditor(),
    "remove-repo": () => active && removeRepo(active),
    palette: actions.togglePalette,
    sidebar: actions.toggleSidebar,
    details: actions.toggleDetail,
    terminal: actions.toggleTerminal,
    "zoom-in": () => actions.zoom(0.1),
    "zoom-out": () => actions.zoom(-0.1),
    "zoom-reset": () => actions.zoom(0),
    refresh: () => refresh(true),
    fetch: () => actions.fetch(),
    pull: () => actions.pull(),
    push: () => actions.push(),
    branch: () => actions.createBranch(),
    stash: actions.stash,
    pop: () => snap?.stashes.length && actions.pop(0),
  };
  const needsRepo = !["settings", "open", "palette", "sidebar", "details", "zoom-in", "zoom-out", "zoom-reset"].includes(id);
  if (needsRepo && !active) return;
  byId[id]?.();
}
