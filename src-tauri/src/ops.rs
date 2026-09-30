use crate::git::{self, head_branch, head_sha, rev_parse, run, run_input, Res};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub enum Head {
    Branch(String),
    Detached(String),
}

fn current_head(repo: &Path) -> Res<Head> {
    if let Some(branch) = head_branch(repo) {
        return Ok(Head::Branch(branch));
    }
    head_sha(repo).map(Head::Detached).ok_or_else(|| "HEAD is not a commit".to_string())
}

fn checkout_head(repo: &Path, head: &Head) -> Res<()> {
    match head {
        Head::Branch(name) => run(repo, &["checkout", name])?,
        Head::Detached(sha) => run(repo, &["checkout", "--detach", sha])?,
    };
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
pub enum Reset {
    Soft,
    Mixed,
    Keep,
}

impl Reset {
    fn flag(self) -> &'static str {
        match self {
            Reset::Soft => "--soft",
            Reset::Mixed => "--mixed",
            Reset::Keep => "--keep",
        }
    }
}

#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub enum Content {
    Absent,
    File { blob: String, exec: bool },
    Link(String),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Saved {
    path: String,
    before: Content,
    after: Content,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Op {
    Commit { before: Option<String>, after: String, amend: bool, summary: String },
    Checkout { before: Head, after: Head },
    CreateBranch { name: String, sha: String, prev_head: Option<Head> },
    DeleteBranch { name: String, sha: String },
    RenameBranch { from: String, to: String },
    Ref { label: String, name: String, before: Option<String>, after: Option<String> },
    Move { label: String, before: String, after: String, reset: Reset },
    StashPush { sha: String, message: String, untracked: bool },
    StashDrop { sha: String, message: String },
    Worktree { label: String, files: Vec<Saved> },
}

fn short(sha: &str) -> &str {
    &sha[..7.min(sha.len())]
}

impl Op {
    fn label(&self) -> String {
        match self {
            Op::Commit { amend: true, summary, .. } => format!("amend \"{summary}\""),
            Op::Commit { summary, .. } => format!("commit \"{summary}\""),
            Op::Checkout { after: Head::Branch(name), .. } => format!("checkout {name}"),
            Op::Checkout { after: Head::Detached(sha), .. } => format!("checkout {}", short(sha)),
            Op::CreateBranch { name, .. } => format!("create branch {name}"),
            Op::DeleteBranch { name, .. } => format!("delete branch {name}"),
            Op::RenameBranch { from, to } => format!("rename {from} to {to}"),
            Op::StashPush { .. } => "stash changes".into(),
            Op::StashDrop { .. } => "drop stash".into(),
            Op::Ref { label, .. } | Op::Move { label, .. } | Op::Worktree { label, .. } => label.clone(),
        }
    }

    fn undo(&self, repo: &Path) -> Res<()> {
        match self {
            Op::Commit { before, after, .. } => {
                expect(head_sha(repo).as_deref() == Some(after.as_str()), "HEAD moved")?;
                match before {
                    Some(sha) => run(repo, &["reset", "--soft", sha])?,
                    None => run(repo, &["update-ref", "-d", "HEAD"])?,
                };
            }
            Op::Checkout { before, after } => {
                expect(current_head(repo)? == *after, "HEAD moved")?;
                checkout_head(repo, before)?;
            }
            Op::CreateBranch { name, sha, prev_head } => {
                expect(branch_sha(repo, name).as_deref() == Some(sha.as_str()), "the branch moved")?;
                if let Some(prev) = prev_head {
                    if current_head(repo)? == Head::Branch(name.clone()) {
                        checkout_head(repo, prev)?;
                    }
                }
                run(repo, &["branch", "-D", name])?;
            }
            Op::DeleteBranch { name, sha } => {
                expect(branch_sha(repo, name).is_none(), "a branch with that name exists")?;
                run(repo, &["branch", name, sha])?;
            }
            Op::RenameBranch { from, to } => {
                expect(branch_sha(repo, to).is_some() && branch_sha(repo, from).is_none(), "the branches changed")?;
                run(repo, &["branch", "-m", to, from])?;
            }
            Op::Ref { name, before, after, .. } => {
                expect(ref_target(repo, name) == *after, "the ref moved")?;
                set_ref(repo, name, before.as_deref())?;
            }
            Op::Move { before, after, reset, .. } => {
                expect(head_sha(repo).as_deref() == Some(after.as_str()), "HEAD moved")?;
                run(repo, &["reset", reset.flag(), before])?;
            }
            Op::StashPush { sha, .. } => {
                expect(ref_target(repo, "refs/stash").as_deref() == Some(sha.as_str()), "the stash list changed")?;
                run(repo, &["stash", "pop", "--index"])?;
            }
            Op::StashDrop { sha, message } => {
                expect(stash_index(repo, sha)?.is_none(), "the stash list changed")?;
                run(repo, &["stash", "store", "-m", message, sha])?;
            }
            Op::Worktree { files, .. } => swap(repo, files, false)?,
        }
        Ok(())
    }

    /// Reapplies the action. Returns the op to record, which differs when redoing creates new objects.
    fn redo(&self, repo: &Path) -> Res<Op> {
        match self {
            Op::Commit { before, after, .. } => {
                expect(head_sha(repo) == *before, "HEAD moved")?;
                run(repo, &["reset", "--soft", after])?;
            }
            Op::Checkout { before, after } => {
                expect(current_head(repo)? == *before, "HEAD moved")?;
                checkout_head(repo, after)?;
            }
            Op::CreateBranch { name, sha, prev_head } => {
                expect(branch_sha(repo, name).is_none(), "a branch with that name exists")?;
                run(repo, &["branch", name, sha])?;
                if prev_head.is_some() {
                    run(repo, &["checkout", name])?;
                }
            }
            Op::DeleteBranch { name, sha } => {
                expect(branch_sha(repo, name).as_deref() == Some(sha.as_str()), "the branch moved")?;
                run(repo, &["branch", "-D", name])?;
            }
            Op::RenameBranch { from, to } => {
                expect(branch_sha(repo, from).is_some() && branch_sha(repo, to).is_none(), "the branches changed")?;
                run(repo, &["branch", "-m", from, to])?;
            }
            Op::Ref { name, before, after, .. } => {
                expect(ref_target(repo, name) == *before, "the ref moved")?;
                set_ref(repo, name, after.as_deref())?;
            }
            Op::Move { before, after, reset, .. } => {
                expect(head_sha(repo).as_deref() == Some(before.as_str()), "HEAD moved")?;
                run(repo, &["reset", reset.flag(), after])?;
            }
            Op::StashPush { message, untracked, .. } => return stash_push(repo, message, *untracked),
            Op::StashDrop { sha, .. } => {
                let index = stash_index(repo, sha)?.ok_or("Nothing to redo safely: the stash is gone")?;
                run(repo, &["stash", "drop", &format!("stash@{{{index}}}")])?;
            }
            Op::Worktree { files, .. } => swap(repo, files, true)?,
        }
        Ok(self.clone())
    }
}

fn expect(ok: bool, why: &str) -> Res<()> {
    if ok {
        Ok(())
    } else {
        Err(format!("Nothing to undo safely: {why} since this action"))
    }
}

fn branch_sha(repo: &Path, name: &str) -> Option<String> {
    rev_parse(repo, &format!("refs/heads/{name}"))
}

/// The object a ref points at, without peeling annotated tags.
fn ref_target(repo: &Path, name: &str) -> Option<String> {
    git::read(repo, &["rev-parse", "-q", "--verify", name])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn set_ref(repo: &Path, name: &str, target: Option<&str>) -> Res<()> {
    match target {
        Some(sha) => run(repo, &["update-ref", name, sha])?,
        None => run(repo, &["update-ref", "-d", name])?,
    };
    Ok(())
}

fn stash_index(repo: &Path, sha: &str) -> Res<Option<u32>> {
    Ok(git::stashes(repo)?.into_iter().find(|s| s.sha == sha).map(|s| s.index))
}

#[cfg(unix)]
fn is_exec(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_exec(_meta: &std::fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
fn set_exec(path: &Path, exec: bool) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)?.permissions();
    let mode = perms.mode();
    perms.set_mode(if exec { mode | ((mode & 0o444) >> 2) } else { mode & !0o111 });
    std::fs::set_permissions(path, perms)
}

#[cfg(not(unix))]
fn set_exec(_path: &Path, _exec: bool) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn make_link(target: &str, path: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, path)
}

#[cfg(not(unix))]
fn make_link(_target: &str, _path: &Path) -> std::io::Result<()> {
    Err(std::io::Error::other("symlinks are not supported"))
}

/// Captures each path's worktree content, storing file bytes as unfiltered blobs.
fn read_contents(repo: &Path, paths: &[String]) -> Res<Vec<Content>> {
    let mut contents = Vec::with_capacity(paths.len());
    let mut files = Vec::new();
    for (i, path) in paths.iter().enumerate() {
        let full = git::worktree_path(repo, path)?;
        let content = match std::fs::symlink_metadata(&full) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Content::Absent,
            Err(e) => return Err(format!("{path}: {e}")),
            Ok(meta) if meta.file_type().is_symlink() => {
                let target = std::fs::read_link(&full).map_err(|e| format!("{path}: {e}"))?;
                Content::Link(target.to_string_lossy().into_owned())
            }
            Ok(meta) if meta.is_file() => {
                files.push(i);
                Content::File { blob: String::new(), exec: is_exec(&meta) }
            }
            Ok(_) => return Err(format!("{path} is a directory")),
        };
        contents.push(content);
    }
    if !files.is_empty() {
        let input: String = files.iter().map(|&i| format!("{}\n", paths[i])).collect();
        let out = run_input(repo, &["hash-object", "-w", "--no-filters", "--stdin-paths"], input.as_bytes())?;
        let shas: Vec<&str> = out.lines().collect();
        if shas.len() != files.len() {
            return Err("could not snapshot the files".into());
        }
        for (&i, sha) in files.iter().zip(shas) {
            if let Content::File { blob, .. } = &mut contents[i] {
                *blob = sha.to_string();
            }
        }
    }
    Ok(contents)
}

fn write_content(repo: &Path, path: &str, content: &Content) -> Res<()> {
    let full = git::worktree_path(repo, path)?;
    let io = |e: std::io::Error| format!("{path}: {e}");
    match std::fs::symlink_metadata(&full) {
        Ok(meta) if meta.is_dir() => return Err(format!("{path} is a directory")),
        Ok(_) => std::fs::remove_file(&full).map_err(io)?,
        Err(_) => {}
    }
    if matches!(content, Content::Absent) {
        return Ok(());
    }
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(io)?;
    }
    match content {
        Content::File { blob, exec } => {
            let bytes = git::run_bytes(repo, &["cat-file", "blob", blob])?;
            std::fs::write(&full, bytes).map_err(io)?;
            set_exec(&full, *exec).map_err(io)?;
        }
        Content::Link(target) => make_link(target, &full).map_err(io)?,
        Content::Absent => {}
    }
    Ok(())
}

/// Moves each file from one saved state to the other, refusing if any file changed since.
fn swap(repo: &Path, files: &[Saved], forward: bool) -> Res<()> {
    let paths: Vec<String> = files.iter().map(|f| f.path.clone()).collect();
    let current = read_contents(repo, &paths)?;
    for (file, now) in files.iter().zip(&current) {
        let from = if forward { &file.before } else { &file.after };
        expect(now == from, &format!("{} changed", file.path))?;
    }
    for file in files {
        write_content(repo, &file.path, if forward { &file.after } else { &file.before })?;
    }
    Ok(())
}

/// Runs `change` and records how each path's worktree content moved. Returns no op when
/// a path cannot be captured, such as a submodule directory.
fn tracked_change(repo: &Path, paths: Vec<String>, label: String, change: impl FnOnce() -> Res<()>) -> Res<Option<Op>> {
    let before = read_contents(repo, &paths).ok();
    change()?;
    let Some(before) = before else { return Ok(None) };
    let after = read_contents(repo, &paths)?;
    let files: Vec<Saved> = paths
        .into_iter()
        .zip(before.into_iter().zip(after))
        .filter(|(_, (b, a))| b != a)
        .map(|(path, (before, after))| Saved { path, before, after })
        .collect();
    Ok((!files.is_empty()).then_some(Op::Worktree { label, files }))
}

#[derive(Default, Serialize, Deserialize)]
struct Journal {
    undo: Vec<Op>,
    redo: Vec<Op>,
}

const JOURNAL_DEPTH: usize = 100;

pub struct Journals {
    file: PathBuf,
    all: Mutex<HashMap<PathBuf, Journal>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub undo: Option<String>,
    pub redo: Option<String>,
}

impl Journals {
    pub fn load(file: PathBuf) -> Self {
        let all = std::fs::read(&file).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
        Journals { file, all: Mutex::new(all) }
    }

    fn save(&self, all: &HashMap<PathBuf, Journal>) {
        let Ok(bytes) = serde_json::to_vec(all) else { return };
        let tmp = self.file.with_extension("json.tmp");
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(&tmp, &self.file);
        }
    }

    pub fn record(&self, repo: &Path, op: Op) {
        let mut all = self.all.lock().unwrap();
        let journal = all.entry(repo.to_path_buf()).or_default();
        journal.undo.push(op);
        if journal.undo.len() > JOURNAL_DEPTH {
            journal.undo.remove(0);
        }
        journal.redo.clear();
        self.save(&all);
    }

    pub fn history(&self, repo: &Path) -> History {
        let all = self.all.lock().unwrap();
        let journal = all.get(repo);
        History {
            undo: journal.and_then(|j| j.undo.last()).map(Op::label),
            redo: journal.and_then(|j| j.redo.last()).map(Op::label),
        }
    }

    pub fn undo(&self, repo: &Path) -> Res<String> {
        let mut all = self.all.lock().unwrap();
        let journal = all.entry(repo.to_path_buf()).or_default();
        let op = journal.undo.pop().ok_or("Nothing to undo")?;
        let result = op.undo(repo);
        let label = op.label();
        match result {
            Ok(()) => journal.redo.push(op),
            Err(_) => journal.undo.clear(),
        }
        self.save(&all);
        result.map(|()| label)
    }

    pub fn redo(&self, repo: &Path) -> Res<String> {
        let mut all = self.all.lock().unwrap();
        let journal = all.entry(repo.to_path_buf()).or_default();
        let op = journal.redo.pop().ok_or("Nothing to redo")?;
        let label = op.label();
        let result = match op.redo(repo) {
            Ok(next) => {
                journal.undo.push(next);
                Ok(label)
            }
            Err(e) => {
                journal.redo.clear();
                Err(e)
            }
        };
        self.save(&all);
        result
    }
}

pub fn commit(repo: &Path, message: &str, amend: bool, sign: bool) -> Res<Op> {
    if message.trim().is_empty() {
        return Err("Commit message is empty".into());
    }
    let before = head_sha(repo);
    let mut args = vec!["commit", "--cleanup=strip", "-F", "-"];
    if amend {
        args.push("--amend");
    }
    if sign {
        args.push("-S");
    }
    run_input(repo, &args, message.as_bytes())?;
    let after = head_sha(repo).ok_or("commit did not create HEAD")?;
    let summary = message.lines().next().unwrap_or("").chars().take(60).collect();
    Ok(Op::Commit { before, after, amend, summary })
}

fn split_remote(repo: &Path, target: &str) -> Res<(String, String)> {
    let remote = git::remotes(repo)?
        .into_iter()
        .filter(|r| target.starts_with(&format!("{r}/")))
        .max_by_key(String::len)
        .ok_or_else(|| format!("no remote matches {target}"))?;
    let branch = target[remote.len() + 1..].to_string();
    Ok((remote, branch))
}

/// `kind` is "local", "remote" or "commit". A remote branch checks out its local
/// counterpart, creating a tracking branch when none exists.
pub fn checkout(repo: &Path, target: &str, kind: &str) -> Res<Op> {
    let before = current_head(repo)?;
    if kind == "remote" {
        let (_, local) = split_remote(repo, target)?;
        if branch_sha(repo, &local).is_none() {
            run(repo, &["checkout", "-b", &local, "--track", target])?;
            let sha = branch_sha(repo, &local).ok_or("branch was not created")?;
            return Ok(Op::CreateBranch { name: local, sha, prev_head: Some(before) });
        }
        run(repo, &["checkout", &local])?;
    } else if kind == "commit" {
        run(repo, &["checkout", "--detach", target])?;
    } else {
        run(repo, &["checkout", target])?;
    }
    Ok(Op::Checkout { before, after: current_head(repo)? })
}

pub fn create_branch(repo: &Path, name: &str, start: &str, checkout: bool) -> Res<Op> {
    let prev_head = if checkout { Some(current_head(repo)?) } else { None };
    run(repo, &["branch", name, start])?;
    let sha = branch_sha(repo, name).ok_or("branch was not created")?;
    if checkout {
        if let Err(e) = run(repo, &["checkout", name]) {
            return Err(format!("Created {name} but could not check it out: {e}"));
        }
    }
    Ok(Op::CreateBranch { name: name.to_string(), sha, prev_head })
}

pub fn delete_branch(repo: &Path, name: &str, force: bool) -> Res<Op> {
    let sha = branch_sha(repo, name).ok_or_else(|| format!("no branch named {name}"))?;
    run(repo, &["branch", if force { "-D" } else { "-d" }, name])?;
    Ok(Op::DeleteBranch { name: name.to_string(), sha })
}

pub fn rename_branch(repo: &Path, from: &str, to: &str) -> Res<Op> {
    run(repo, &["branch", "-m", from, to])?;
    Ok(Op::RenameBranch { from: from.to_string(), to: to.to_string() })
}

pub fn create_tag(repo: &Path, name: &str, sha: &str, message: &str) -> Res<Op> {
    if message.trim().is_empty() {
        run(repo, &["tag", name, sha])?;
    } else {
        run_input(repo, &["tag", "-a", name, "-F", "-", sha], message.as_bytes())?;
    }
    let full = format!("refs/tags/{name}");
    let after = ref_target(repo, &full);
    Ok(Op::Ref { label: format!("create tag {name}"), name: full, before: None, after })
}

pub fn delete_tag(repo: &Path, name: &str) -> Res<Op> {
    let full = format!("refs/tags/{name}");
    let before = ref_target(repo, &full).ok_or_else(|| format!("no tag named {name}"))?;
    run(repo, &["tag", "-d", name])?;
    Ok(Op::Ref { label: format!("delete tag {name}"), name: full, before: Some(before), after: None })
}

fn conflict_error(repo: &Path, what: &str, error: String) -> String {
    let conflicts = git::status(repo).map(|s| s.conflicted.len()).unwrap_or(0);
    if git::repo_state(repo).is_some() && conflicts > 0 {
        let files = if conflicts == 1 { "1 file".to_string() } else { format!("{conflicts} files") };
        format!("{what} stopped with conflicts in {files}. Resolve them in the changes panel, then continue.")
    } else {
        error
    }
}

/// Runs a history-rewriting command and records how HEAD moved.
fn moving(repo: &Path, label: String, reset: Reset, args: &[&str]) -> Res<Option<Op>> {
    let before = head_sha(repo).ok_or("HEAD is not a commit")?;
    let what = label.split(' ').next().unwrap_or("git").to_string();
    run(repo, args).map_err(|e| conflict_error(repo, &capitalize(&what), e))?;
    let after = head_sha(repo).ok_or("HEAD is not a commit")?;
    Ok((after != before).then_some(Op::Move { label, before, after, reset }))
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

fn is_merge(repo: &Path, sha: &str) -> bool {
    rev_parse(repo, &format!("{sha}^2")).is_some()
}

pub fn merge(repo: &Path, target: &str, no_ff: bool) -> Res<Option<Op>> {
    let mut args = vec!["merge", "--no-edit"];
    if no_ff {
        args.push("--no-ff");
    }
    args.push(target);
    moving(repo, format!("merge {target}"), Reset::Keep, &args)
}

pub fn rebase(repo: &Path, onto: &str) -> Res<Option<Op>> {
    moving(repo, format!("rebase onto {onto}"), Reset::Keep, &["rebase", onto])
}

pub fn cherry_pick(repo: &Path, sha: &str) -> Res<Option<Op>> {
    let mut args = vec!["cherry-pick"];
    if is_merge(repo, sha) {
        args.extend_from_slice(&["-m", "1"]);
    }
    args.push(sha);
    moving(repo, format!("cherry-pick {}", short(sha)), Reset::Keep, &args)
}

pub fn revert(repo: &Path, sha: &str) -> Res<Option<Op>> {
    let mut args = vec!["revert", "--no-edit"];
    if is_merge(repo, sha) {
        args.extend_from_slice(&["-m", "1"]);
    }
    args.push(sha);
    moving(repo, format!("revert {}", short(sha)), Reset::Keep, &args)
}

/// A hard reset first stores uncommitted changes as a stash, so they stay recoverable.
pub fn reset(repo: &Path, sha: &str, mode: &str) -> Res<Option<Op>> {
    let (flag, back) = match mode {
        "soft" => ("--soft", Reset::Soft),
        "mixed" => ("--mixed", Reset::Mixed),
        "hard" => ("--hard", Reset::Keep),
        _ => return Err(format!("unknown reset mode {mode}")),
    };
    if mode == "hard" {
        let backup = run(repo, &["stash", "create"])?.trim().to_string();
        if !backup.is_empty() {
            let message = format!("Ahtapot backup before reset to {}", short(sha));
            run(repo, &["stash", "store", "-m", &message, &backup])?;
        }
    }
    moving(repo, format!("reset to {}", short(sha)), back, &["reset", flag, sha])
}

/// `action` is "continue", "abort" or "skip" for the merge, rebase, cherry-pick or revert in progress.
/// Records the whole operation for undo once continuing or skipping finishes it.
pub fn sequence(repo: &Path, action: &str) -> Res<Option<Op>> {
    if !matches!(action, "continue" | "abort" | "skip") {
        return Err(format!("unknown action {action}"));
    }
    let command = match git::repo_state(repo).as_deref() {
        Some("merging") if action == "skip" => return Err("A merge cannot be skipped".into()),
        Some("merging") => "merge",
        Some("rebasing") => "rebase",
        Some("cherry-picking") => "cherry-pick",
        Some("reverting") => "revert",
        _ => return Err("No merge, rebase, cherry-pick or revert is in progress".into()),
    };
    let before = if command == "rebase" { rev_parse(repo, "ORIG_HEAD") } else { head_sha(repo) };
    run(repo, &[command, &format!("--{action}")]).map_err(|e| conflict_error(repo, &capitalize(command), e))?;
    if action == "abort" || git::repo_state(repo).is_some() {
        return Ok(None);
    }
    let (Some(before), Some(after)) = (before, head_sha(repo)) else { return Ok(None) };
    Ok((before != after).then(|| Op::Move { label: command.to_string(), before, after, reset: Reset::Keep }))
}

/// `side` is "ours" (HEAD) or "theirs" (the incoming change).
pub fn resolve(repo: &Path, path: &str, side: &str) -> Res<()> {
    if !matches!(side, "ours" | "theirs") {
        return Err(format!("unknown side {side}"));
    }
    run(repo, &["checkout", &format!("--{side}"), "--", path])?;
    run(repo, &["add", "--", path]).map(drop)
}

pub fn fetch(repo: &Path, remote: Option<&str>, prune: bool) -> Res<()> {
    let mut args = vec!["fetch"];
    match remote {
        Some(r) => args.push(r),
        None => args.push("--all"),
    }
    if prune {
        args.push("--prune");
    }
    run(repo, &args).map(drop)
}

pub fn pull(repo: &Path, mode: &str) -> Res<()> {
    let flag = match mode {
        "ff-only" => "--ff-only",
        "rebase" => "--rebase",
        _ => "--no-rebase",
    };
    run(repo, &["pull", flag, "--no-edit"]).map_err(|e| conflict_error(repo, "Pull", e)).map(drop)
}

fn default_remote(repo: &Path) -> Res<String> {
    let remotes = git::remotes(repo)?;
    remotes
        .iter()
        .find(|r| *r == "origin")
        .or(remotes.first())
        .cloned()
        .ok_or_else(|| "this repository has no remotes".into())
}

/// Pushes `branch`, or the checked-out branch, setting its upstream when it has none.
pub fn push(repo: &Path, force: bool, branch: Option<&str>) -> Res<()> {
    let branch = match branch {
        Some(b) => b.to_string(),
        None => head_branch(repo).ok_or("HEAD is detached; check out a branch to push")?,
    };
    let mut args = vec!["push".to_string()];
    if force {
        args.push("--force-with-lease".into());
    }
    let remote = git::config_get(repo, &format!("branch.{branch}.remote"), "effective")?.filter(|r| r != ".");
    let merge = git::config_get(repo, &format!("branch.{branch}.merge"), "effective")?;
    match (remote, merge) {
        (Some(remote), Some(merge)) => args.extend([remote, format!("refs/heads/{branch}:{merge}")]),
        _ => args.extend(["-u".into(), default_remote(repo)?, branch]),
    }
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    run(repo, &args).map(drop)
}

pub fn push_tag(repo: &Path, name: &str) -> Res<()> {
    run(repo, &["push", &default_remote(repo)?, &format!("refs/tags/{name}")]).map(drop)
}

/// `target` is a remote-tracking name such as `origin/feature`.
pub fn delete_remote_branch(repo: &Path, target: &str) -> Res<()> {
    let (remote, branch) = split_remote(repo, target)?;
    run(repo, &["push", &remote, "--delete", &branch]).map(drop)
}

pub fn remote_add(repo: &Path, name: &str, url: &str) -> Res<()> {
    run(repo, &["remote", "add", name, url]).map(drop)
}

pub fn remote_remove(repo: &Path, name: &str) -> Res<()> {
    run(repo, &["remote", "remove", name]).map(drop)
}

pub fn stash_push(repo: &Path, message: &str, untracked: bool) -> Res<Op> {
    let before = ref_target(repo, "refs/stash");
    let mut args = vec!["stash", "push"];
    if untracked {
        args.push("--include-untracked");
    }
    if !message.trim().is_empty() {
        args.extend_from_slice(&["-m", message]);
    }
    run(repo, &args)?;
    let sha = ref_target(repo, "refs/stash").filter(|s| Some(s) != before.as_ref()).ok_or("No local changes to stash")?;
    Ok(Op::StashPush { sha, message: message.to_string(), untracked })
}

pub fn stash_apply(repo: &Path, pop: bool, index: u32) -> Res<()> {
    let action = if pop { "pop" } else { "apply" };
    run(repo, &["stash", action, &format!("stash@{{{index}}}")]).map_err(|e| conflict_error(repo, "Stash", e)).map(drop)
}

pub fn stash_drop(repo: &Path, index: u32) -> Res<Op> {
    let stash = git::stashes(repo)?.into_iter().find(|s| s.index == index).ok_or("no such stash")?;
    run(repo, &["stash", "drop", &format!("stash@{{{index}}}")])?;
    Ok(Op::StashDrop { sha: stash.sha, message: stash.message })
}

fn chunked(repo: &Path, prefix: &[&str], paths: &[String]) -> Res<()> {
    for chunk in paths.chunks(400) {
        let mut args: Vec<&str> = prefix.to_vec();
        args.push("--");
        args.extend(chunk.iter().map(String::as_str));
        run(repo, &args)?;
    }
    Ok(())
}

pub fn stage(repo: &Path, paths: &[String]) -> Res<()> {
    chunked(repo, &["add", "-A"], paths)
}

pub fn unstage(repo: &Path, paths: &[String]) -> Res<()> {
    if head_sha(repo).is_some() {
        chunked(repo, &["restore", "--staged"], paths)
    } else {
        chunked(repo, &["rm", "--cached", "-r", "-q"], paths)
    }
}

fn plural(n: usize, one: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {one}s")
    }
}

pub fn discard(repo: &Path, tracked: &[String], untracked: &[String]) -> Res<Option<Op>> {
    let paths: Vec<String> = tracked.iter().chain(untracked).cloned().collect();
    let label = match paths.as_slice() {
        [one] => format!("discard {one}"),
        _ => format!("discard {}", plural(paths.len(), "file")),
    };
    tracked_change(repo, paths, label, || {
        if !tracked.is_empty() {
            chunked(repo, &["restore", "--worktree"], tracked)?;
        }
        if !untracked.is_empty() {
            chunked(repo, &["clean", "-f", "-q"], untracked)?;
        }
        Ok(())
    })
}

pub fn apply_patch(repo: &Path, patch: &str, cached: bool, reverse: bool) -> Res<()> {
    let mut args = vec!["apply", "--recount", "--whitespace=nowarn"];
    if cached {
        args.push("--cached");
    }
    if reverse {
        args.push("--reverse");
    }
    args.push("-");
    run_input(repo, &args, patch.as_bytes()).map(drop)
}

/// Applies `patch` to the worktree copy of `path`, recording the change for undo.
pub fn apply_worktree(repo: &Path, patch: &str, reverse: bool, path: &str) -> Res<Option<Op>> {
    let label = format!("discard lines in {path}");
    tracked_change(repo, vec![path.to_string()], label, || apply_patch(repo, patch, false, reverse))
}
