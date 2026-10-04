import { Channel, invoke } from "@tauri-apps/api/core";

export interface Commit {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  subject: string;
  body: string;
}

export interface Ref {
  name: string;
  short: string;
  kind: "local" | "remote" | "tag";
  sha: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
  isHead: boolean;
}

export interface Stash {
  index: number;
  sha: string;
  message: string;
  time: number;
}

export interface FileChange {
  path: string;
  origPath: string | null;
  status: string;
}

export interface Status {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: FileChange[];
  unstaged: FileChange[];
  conflicted: FileChange[];
  state: string | null;
}

export interface Snapshot {
  status: Status;
  refs: Ref[];
  stashes: Stash[];
  remotes: string[];
  history: { undo: string | null; redo: string | null };
}

export interface DetailFile {
  path: string;
  origPath: string | null;
  status: string;
  additions: number | null;
  deletions: number | null;
}

export interface CommitDetail {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  authorTime: number;
  committer: string;
  committerEmail: string;
  commitTime: number;
  message: string;
  files: DetailFile[];
}

export interface EnvInfo {
  user: string;
  host: string;
  home: string;
  shell: string;
  gitVersion: string | null;
  launchRepo: string | null;
}

export interface DiffOpts {
  ignoreWhitespace: boolean;
  context: number;
}

export type ConfigScope = "global" | "local" | "effective";
export type ResetMode = "soft" | "mixed" | "hard";
export type SequenceAction = "continue" | "abort" | "skip";

export interface RepoList {
  repos: string[];
  active: string | null;
}

export type PullMode = "ff" | "ff-only" | "rebase";
export type PtyEvent = { kind: "data"; data: string } | { kind: "exit" };
export type AiEvent = { kind: "text"; data: string } | { kind: "done" };
export type KeySource = "env" | "keychain" | "none";

export interface AiConfig {
  provider: string;
  protocol: "anthropic" | "openai";
  baseUrl: string;
  model: string;
  envKey: string | null;
}

export const api = {
  reposLoad: () => invoke<RepoList>("repos_load"),
  githubAvatar: (repo: string, email: string) => invoke<string | null>("github_avatar", { repo, email }),
  setAppIcon: (style: string) => invoke<void>("set_app_icon", { style }),
  showEmojiPicker: () => invoke<void>("show_emoji_picker"),
  reposSave: (list: RepoList) => invoke<void>("repos_save", { list }),
  settingsLoad: () => invoke<unknown>("settings_load"),
  settingsSave: (settings: unknown) => invoke<void>("settings_save", { settings }),
  repoResolve: (path: string) => invoke<string>("repo_resolve", { path }),
  envInfo: () => invoke<EnvInfo>("env_info"),
  snapshot: (repo: string) => invoke<Snapshot>("snapshot", { repo }),
  changeCount: (repo: string) => invoke<number>("change_count", { repo }),
  log: (repo: string, skip: number, limit: number) => invoke<Commit[]>("log", { repo, skip, limit }),
  logPosition: (repo: string, sha: string) => invoke<number | null>("log_position", { repo, sha }),
  searchCommits: (repo: string, query: string, limit: number) => invoke<Commit[]>("search_commits", { repo, query, limit }),
  commitDetail: (repo: string, sha: string) => invoke<CommitDetail>("commit_detail", { repo, sha }),
  treeFiles: (repo: string, sha: string) => invoke<string[]>("tree_files", { repo, sha }),
  diffCommit: (repo: string, sha: string, path: string, origPath: string | null, opts: DiffOpts) =>
    invoke<string>("diff_commit", { repo, sha, path, origPath, opts }),
  diffWip: (repo: string, path: string, origPath: string | null, staged: boolean, untracked: boolean, opts: DiffOpts) =>
    invoke<string>("diff_wip", { repo, path, origPath, staged, untracked, opts }),
  commitMessage: (repo: string, rev: string) => invoke<string>("commit_message", { repo, rev }),
  readFile: (repo: string, path: string) => invoke<string>("read_file", { repo, path }),
  readBlob: (repo: string, rev: string | null, path: string) => invoke<ArrayBuffer>("read_blob", { repo, rev, path }),
  writeFile: (repo: string, path: string, text: string) => invoke<void>("write_file", { repo, path, text }),
  configGet: (repo: string, key: string, scope: ConfigScope) => invoke<string | null>("config_get", { repo, key, scope }),
  configSet: (repo: string, key: string, value: string, scope: ConfigScope) => invoke<void>("config_set", { repo, key, value, scope }),
  commit: (repo: string, message: string, amend: boolean, sign: boolean) => invoke<void>("commit", { repo, message, amend, sign }),
  checkout: (repo: string, target: string, kind: "local" | "remote" | "commit") =>
    invoke<void>("checkout", { repo, target, kind }),
  createBranch: (repo: string, name: string, start: string, checkout: boolean) =>
    invoke<void>("create_branch", { repo, name, start, checkout }),
  deleteBranch: (repo: string, name: string, force: boolean) => invoke<void>("delete_branch", { repo, name, force }),
  renameBranch: (repo: string, from: string, to: string) => invoke<void>("rename_branch", { repo, from, to }),
  createTag: (repo: string, name: string, sha: string, message: string) => invoke<void>("create_tag", { repo, name, sha, message }),
  deleteTag: (repo: string, name: string) => invoke<void>("delete_tag", { repo, name }),
  merge: (repo: string, target: string, noFf: boolean) => invoke<void>("merge", { repo, target, noFf }),
  rebase: (repo: string, onto: string) => invoke<void>("rebase", { repo, onto }),
  cherryPick: (repo: string, sha: string) => invoke<void>("cherry_pick", { repo, sha }),
  revert: (repo: string, sha: string) => invoke<void>("revert", { repo, sha }),
  reset: (repo: string, sha: string, mode: ResetMode) => invoke<void>("reset", { repo, sha, mode }),
  sequence: (repo: string, action: SequenceAction) => invoke<void>("sequence", { repo, action }),
  resolve: (repo: string, path: string, side: "ours" | "theirs") => invoke<void>("resolve", { repo, path, side }),
  undo: (repo: string) => invoke<string>("undo", { repo }),
  redo: (repo: string) => invoke<string>("redo", { repo }),
  fetch: (repo: string, remote: string | null, prune: boolean) => invoke<void>("fetch", { repo, remote, prune }),
  pull: (repo: string, mode: PullMode) => invoke<void>("pull", { repo, mode }),
  push: (repo: string, force: boolean, branch: string | null) => invoke<void>("push", { repo, force, branch }),
  pushTag: (repo: string, name: string) => invoke<void>("push_tag", { repo, name }),
  deleteRemoteBranch: (repo: string, target: string) => invoke<void>("delete_remote_branch", { repo, target }),
  remoteAdd: (repo: string, name: string, url: string) => invoke<void>("remote_add", { repo, name, url }),
  remoteRemove: (repo: string, name: string) => invoke<void>("remote_remove", { repo, name }),
  stashPush: (repo: string, message: string, untracked: boolean) =>
    invoke<void>("stash_push", { repo, message, untracked }),
  stashApply: (repo: string, pop: boolean, index: number) => invoke<void>("stash_apply", { repo, pop, index }),
  stashDrop: (repo: string, index: number) => invoke<void>("stash_drop", { repo, index }),
  stage: (repo: string, paths: string[]) => invoke<void>("stage", { repo, paths }),
  unstage: (repo: string, paths: string[]) => invoke<void>("unstage", { repo, paths }),
  discard: (repo: string, tracked: string[], untracked: string[]) =>
    invoke<void>("discard", { repo, tracked, untracked }),
  applyPatch: (repo: string, patch: string, reverse: boolean) => invoke<void>("apply_patch", { repo, patch, reverse }),
  applyWorktree: (repo: string, patch: string, reverse: boolean, path: string) =>
    invoke<void>("apply_worktree", { repo, patch, reverse, path }),
  openPath: (repo: string, path: string | null, editor: string, reveal: boolean) =>
    invoke<void>("open_path", { repo, path, editor, reveal }),
  aiExplain: (repo: string, sha: string, config: AiConfig, onEvent: Channel<AiEvent>) =>
    invoke<void>("ai_explain", { repo, sha, config, onEvent }),
  aiCommitMessage: (repo: string, amend: boolean, limit: number, config: AiConfig, onEvent: Channel<AiEvent>) =>
    invoke<void>("ai_commit_message", { repo, amend, limit, config, onEvent }),
  aiModels: (config: AiConfig) => invoke<string[]>("ai_models", { config }),
  aiKeySource: (provider: string, envKey: string | null) => invoke<KeySource>("ai_key_source", { provider, envKey }),
  aiKeySet: (provider: string, key: string) => invoke<void>("ai_key_set", { provider, key }),
  aiKeyClear: (provider: string) => invoke<void>("ai_key_clear", { provider }),
  watchRepo: (repo: string) => invoke<void>("watch_repo", { repo }),
  ptySpawn: (cwd: string, shell: string, cols: number, rows: number, onEvent: Channel<PtyEvent>) =>
    invoke<number>("pty_spawn", { cwd, shell, cols, rows, onEvent }),
  ptyWrite: (id: number, data: string) => invoke<void>("pty_write", { id, data }),
  ptyResize: (id: number, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  ptyKill: (id: number) => invoke<void>("pty_kill", { id }),
};
