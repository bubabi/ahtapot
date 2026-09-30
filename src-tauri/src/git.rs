use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

pub type Res<T> = Result<T, String>;

const FS: char = '\x1f';
const RS: char = '\x1e';

fn spawn_raw(repo: &Path, args: &[&str], input: Option<&[u8]>, ok_codes: &[i32]) -> Res<Vec<u8>> {
    let mut cmd = Command::new("git");
    cmd.current_dir(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .env("LC_ALL", "C")
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("failed to run git: {e}"))?;
    if let Some(bytes) = input {
        let mut stdin = child.stdin.take().expect("stdin is piped");
        stdin.write_all(bytes).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let code = out.status.code().unwrap_or(-1);
    if !out.status.success() && !ok_codes.contains(&code) {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let text = if stderr.trim().is_empty() { String::from_utf8_lossy(&out.stdout) } else { stderr };
        let lines: Vec<&str> = text.lines().filter(|l| !l.starts_with("hint:")).collect();
        return Err(lines.join("\n").trim().to_string());
    }
    Ok(out.stdout)
}

fn spawn(repo: &Path, args: &[&str], input: Option<&[u8]>, ok_codes: &[i32]) -> Res<String> {
    spawn_raw(repo, args, input, ok_codes).map(|b| String::from_utf8_lossy(&b).into_owned())
}

pub fn run_bytes(repo: &Path, args: &[&str]) -> Res<Vec<u8>> {
    spawn_raw(repo, args, None, &[])
}

pub fn run(repo: &Path, args: &[&str]) -> Res<String> {
    spawn(repo, args, None, &[])
}

pub fn run_input(repo: &Path, args: &[&str], input: &[u8]) -> Res<String> {
    spawn(repo, args, Some(input), &[])
}

/// Read-only invocation. `--no-optional-locks` keeps `status` from rewriting the index,
/// which would otherwise retrigger the file watcher.
pub fn read(repo: &Path, args: &[&str]) -> Res<String> {
    let mut full = vec!["--no-optional-locks"];
    full.extend_from_slice(args);
    spawn(repo, &full, None, &[])
}

fn read_allow(repo: &Path, args: &[&str], ok_codes: &[i32]) -> Res<String> {
    let mut full = vec!["--no-optional-locks"];
    full.extend_from_slice(args);
    spawn(repo, &full, None, ok_codes)
}

pub fn toplevel(path: &Path) -> Res<String> {
    Ok(run(path, &["rev-parse", "--show-toplevel"])?.trim().to_string())
}

pub fn head_sha(repo: &Path) -> Option<String> {
    read(repo, &["rev-parse", "-q", "--verify", "HEAD^{commit}"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn head_branch(repo: &Path) -> Option<String> {
    read(repo, &["symbolic-ref", "-q", "--short", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn rev_parse(repo: &Path, rev: &str) -> Option<String> {
    read(repo, &["rev-parse", "-q", "--verify", &format!("{rev}^{{commit}}")])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub subject: String,
    pub body: String,
}

fn first_line(body: &str) -> String {
    body.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .chars()
        .take(200)
        .collect()
}

const LOG_FORMAT: &str = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b%x1e";

fn graph_revs(repo: &Path) -> Vec<&'static str> {
    let mut revs = vec!["--branches", "--remotes", "--tags"];
    if head_sha(repo).is_some() {
        revs.push("HEAD");
    }
    revs
}

fn parse_commits(out: &str) -> Vec<Commit> {
    out.split(RS)
        .filter_map(|rec| {
            let rec = rec.trim_start_matches('\n');
            if rec.is_empty() {
                return None;
            }
            let f: Vec<&str> = rec.splitn(7, FS).collect();
            if f.len() < 7 {
                return None;
            }
            Some(Commit {
                sha: f[0].to_string(),
                parents: f[1].split_whitespace().map(String::from).collect(),
                author: f[2].to_string(),
                email: f[3].to_string(),
                time: f[4].parse().unwrap_or(0),
                subject: f[5].to_string(),
                body: first_line(f[6]),
            })
        })
        .collect()
}

pub fn log(repo: &Path, skip: usize, limit: usize) -> Res<Vec<Commit>> {
    let revs = graph_revs(repo);
    let skip = format!("--skip={skip}");
    let limit = format!("-n{limit}");
    let mut args = vec!["log", "--date-order", skip.as_str(), limit.as_str(), LOG_FORMAT];
    args.extend(&revs);
    match read(repo, &args) {
        Ok(out) => Ok(parse_commits(&out)),
        Err(_) if !revs.contains(&"HEAD") => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

/// Index of `sha` in the order `log` pages through, or None when no ref reaches it.
pub fn log_position(repo: &Path, sha: &str) -> Res<Option<usize>> {
    let mut args = vec!["rev-list", "--date-order"];
    args.extend(graph_revs(repo));
    let out = read(repo, &args)?;
    Ok(out.lines().position(|line| line == sha))
}

/// Commits whose message or author contains `query`, plus the commit it names as a revision.
pub fn search(repo: &Path, query: &str, limit: usize) -> Res<Vec<Commit>> {
    let revs = graph_revs(repo);
    let limit_arg = format!("-n{limit}");
    let mut found: Vec<Commit> = Vec::new();
    for filter in [format!("--grep={query}"), format!("--author={query}")] {
        let mut args = vec!["log", "-i", "-F", "--date-order", limit_arg.as_str(), LOG_FORMAT, filter.as_str()];
        args.extend(&revs);
        found.extend(parse_commits(&read(repo, &args)?));
    }
    if query.len() >= 4 && query.chars().all(|c| c.is_ascii_hexdigit()) {
        if let Some(sha) = rev_parse(repo, query) {
            found.extend(parse_commits(&read(repo, &["log", "-1", LOG_FORMAT, &sha])?));
        }
    }
    let mut seen = std::collections::HashSet::new();
    found.retain(|c| seen.insert(c.sha.clone()));
    found.sort_by_key(|c| std::cmp::Reverse(c.time));
    found.truncate(limit);
    Ok(found)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ref {
    pub name: String,
    pub short: String,
    pub kind: &'static str,
    pub sha: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub gone: bool,
    pub is_head: bool,
}

fn parse_track(track: &str) -> (u32, u32, bool) {
    let mut ahead = 0;
    let mut behind = 0;
    for part in track.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.parse().unwrap_or(0);
        }
    }
    (ahead, behind, track.trim() == "gone")
}

pub fn refs(repo: &Path) -> Res<Vec<Ref>> {
    let out = read(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname)%1f%(objectname)%1f%(*objectname)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(HEAD)%1f%(symref)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )?;
    Ok(out
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split(FS).collect();
            if f.len() < 7 || !f[6].is_empty() {
                return None;
            }
            let name = f[0];
            let (kind, short) = if let Some(s) = name.strip_prefix("refs/heads/") {
                ("local", s)
            } else if let Some(s) = name.strip_prefix("refs/remotes/") {
                ("remote", s)
            } else if let Some(s) = name.strip_prefix("refs/tags/") {
                ("tag", s)
            } else {
                return None;
            };
            let sha = if f[2].is_empty() { f[1] } else { f[2] };
            let (ahead, behind, gone) = parse_track(f[4]);
            Some(Ref {
                name: name.to_string(),
                short: short.to_string(),
                kind,
                sha: sha.to_string(),
                upstream: (!f[3].is_empty()).then(|| f[3].to_string()),
                ahead,
                behind,
                gone,
                is_head: f[5] == "*",
            })
        })
        .collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stash {
    pub index: u32,
    pub sha: String,
    pub message: String,
    pub time: i64,
}

pub fn stashes(repo: &Path) -> Res<Vec<Stash>> {
    let out = read(repo, &["stash", "list", "--format=%gd%x1f%H%x1f%gs%x1f%ct"])?;
    Ok(out
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split(FS).collect();
            if f.len() < 4 {
                return None;
            }
            let index = f[0].trim_start_matches("stash@{").trim_end_matches('}').parse().ok()?;
            Some(Stash {
                index,
                sha: f[1].to_string(),
                message: f[2].to_string(),
                time: f[3].parse().unwrap_or(0),
            })
        })
        .collect())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub orig_path: Option<String>,
    pub status: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: Vec<FileChange>,
    pub unstaged: Vec<FileChange>,
    pub conflicted: Vec<FileChange>,
    pub state: Option<String>,
}

fn change(path: &str, orig: Option<&str>, status: char) -> FileChange {
    FileChange {
        path: path.to_string(),
        orig_path: orig.map(String::from),
        status: status.to_string(),
    }
}

pub fn status(repo: &Path) -> Res<Status> {
    let out = read(repo, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"])?;
    let mut st = Status::default();
    let mut entries = out.split('\0');
    while let Some(entry) = entries.next() {
        if entry.is_empty() {
            continue;
        }
        if let Some(header) = entry.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" if value != "(initial)" => st.head = Some(value.to_string()),
                "branch.head" if value != "(detached)" => st.branch = Some(value.to_string()),
                "branch.upstream" => st.upstream = Some(value.to_string()),
                "branch.ab" => {
                    for n in value.split_whitespace() {
                        if let Some(a) = n.strip_prefix('+') {
                            st.ahead = a.parse().unwrap_or(0);
                        } else if let Some(b) = n.strip_prefix('-') {
                            st.behind = b.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let kind = entry.as_bytes()[0];
        match kind {
            b'1' | b'2' => {
                let n = if kind == b'1' { 9 } else { 10 };
                let f: Vec<&str> = entry.splitn(n, ' ').collect();
                if f.len() < n {
                    continue;
                }
                let xy: Vec<char> = f[1].chars().collect();
                let path = f[n - 1];
                let orig = if kind == b'2' { entries.next() } else { None };
                if xy[0] != '.' {
                    st.staged.push(change(path, orig, xy[0]));
                }
                if xy[1] != '.' {
                    st.unstaged.push(change(path, None, xy[1]));
                }
            }
            b'u' => {
                if let Some(path) = entry.splitn(11, ' ').nth(10) {
                    st.conflicted.push(change(path, None, 'U'));
                }
            }
            b'?' => st.unstaged.push(change(&entry[2..], None, '?')),
            _ => {}
        }
    }
    st.state = repo_state(repo);
    Ok(st)
}

pub fn repo_state(repo: &Path) -> Option<String> {
    let git_dir = read(repo, &["rev-parse", "--absolute-git-dir"]).ok()?;
    let git_dir = Path::new(git_dir.trim());
    [
        ("MERGE_HEAD", "merging"),
        ("rebase-merge", "rebasing"),
        ("rebase-apply", "rebasing"),
        ("CHERRY_PICK_HEAD", "cherry-picking"),
        ("REVERT_HEAD", "reverting"),
    ]
    .iter()
    .find(|(file, _)| git_dir.join(file).exists())
    .map(|(_, state)| state.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailFile {
    pub path: String,
    pub orig_path: Option<String>,
    pub status: String,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub author_time: i64,
    pub committer: String,
    pub committer_email: String,
    pub commit_time: i64,
    pub message: String,
    pub files: Vec<DetailFile>,
}

fn empty_tree(repo: &Path) -> Res<String> {
    Ok(run_input(repo, &["hash-object", "-t", "tree", "--stdin"], b"")?.trim().to_string())
}

pub fn commit_detail(repo: &Path, sha: &str) -> Res<CommitDetail> {
    let out = read(
        repo,
        &["show", "-s", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B", sha],
    )?;
    let f: Vec<&str> = out.splitn(9, FS).collect();
    if f.len() < 9 {
        return Err(format!("unexpected output for commit {sha}"));
    }
    let parents: Vec<String> = f[1].split_whitespace().map(String::from).collect();
    let base = match parents.first() {
        Some(p) => p.clone(),
        None => empty_tree(repo)?,
    };
    let files = changed_files(repo, &base, sha)?;
    Ok(CommitDetail {
        sha: f[0].to_string(),
        parents,
        author: f[2].to_string(),
        email: f[3].to_string(),
        author_time: f[4].parse().unwrap_or(0),
        committer: f[5].to_string(),
        committer_email: f[6].to_string(),
        commit_time: f[7].parse().unwrap_or(0),
        message: f[8].trim_end().to_string(),
        files,
    })
}

fn changed_files(repo: &Path, base: &str, sha: &str) -> Res<Vec<DetailFile>> {
    let names = read(repo, &["diff-tree", "-r", "-M", "-z", "--name-status", base, sha])?;
    let nums = read(repo, &["diff-tree", "-r", "-M", "-z", "--numstat", base, sha])?;

    let mut counts: HashMap<String, (Option<u32>, Option<u32>)> = HashMap::new();
    let mut it = nums.split('\0');
    while let Some(entry) = it.next() {
        let f: Vec<&str> = entry.splitn(3, '\t').collect();
        if f.len() < 3 {
            continue;
        }
        let path = if f[2].is_empty() {
            it.next();
            it.next().unwrap_or("")
        } else {
            f[2]
        };
        counts.insert(path.to_string(), (f[0].parse().ok(), f[1].parse().ok()));
    }

    let mut files = Vec::new();
    let mut it = names.split('\0');
    while let Some(code) = it.next() {
        if code.is_empty() {
            continue;
        }
        let status = &code[..1];
        let (orig, path) = if status == "R" || status == "C" {
            let old = it.next().unwrap_or("");
            (Some(old.to_string()), it.next().unwrap_or("").to_string())
        } else {
            (None, it.next().unwrap_or("").to_string())
        };
        let (additions, deletions) = counts.get(&path).copied().unwrap_or((None, None));
        files.push(DetailFile { path, orig_path: orig, status: status.to_string(), additions, deletions });
    }
    Ok(files)
}

pub fn tree_files(repo: &Path, sha: &str) -> Res<Vec<String>> {
    let out = read(repo, &["ls-tree", "-r", "-z", "--name-only", sha])?;
    Ok(out.split('\0').filter(|s| !s.is_empty()).map(String::from).collect())
}

const DIFF_FLAGS: [&str; 5] = ["--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "-M"];

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct DiffOpts {
    pub ignore_whitespace: bool,
    pub context: u32,
}

impl DiffOpts {
    fn args(&self) -> Vec<String> {
        let mut args: Vec<String> = DIFF_FLAGS.iter().map(|s| s.to_string()).collect();
        args.push(format!("-U{}", self.context.min(1000)));
        if self.ignore_whitespace {
            args.push("-w".into());
        }
        args
    }
}

pub fn first_parent_or_empty(repo: &Path, sha: &str) -> Res<String> {
    match read(repo, &["rev-parse", "-q", "--verify", &format!("{sha}^1")]) {
        Ok(p) => Ok(p.trim().to_string()),
        Err(_) => empty_tree(repo),
    }
}

pub fn diff_commit(repo: &Path, sha: &str, path: &str, orig_path: Option<&str>, opts: DiffOpts) -> Res<String> {
    let base = first_parent_or_empty(repo, sha)?;
    let flags = opts.args();
    let mut args = vec!["diff"];
    args.extend(flags.iter().map(String::as_str));
    args.extend_from_slice(&[base.as_str(), sha, "--"]);
    if let Some(orig) = orig_path {
        args.push(orig);
    }
    args.push(path);
    read(repo, &args)
}

pub fn diff_wip(repo: &Path, path: &str, orig_path: Option<&str>, staged: bool, untracked: bool, opts: DiffOpts) -> Res<String> {
    let flags = opts.args();
    let mut args = vec!["diff"];
    args.extend(flags.iter().map(String::as_str));
    if untracked {
        args.extend_from_slice(&["--no-index", "--", "/dev/null", path]);
        return read_allow(repo, &args, &[1]);
    }
    if staged {
        args.push("--cached");
    }
    args.push("--");
    if let Some(orig) = orig_path {
        args.push(orig);
    }
    args.push(path);
    read(repo, &args)
}

pub fn commit_message(repo: &Path, rev: &str) -> Res<String> {
    Ok(read(repo, &["show", "-s", "--format=%B", rev])?.trim_end().to_string())
}

pub fn remotes(repo: &Path) -> Res<Vec<String>> {
    Ok(read(repo, &["remote"])?.lines().map(String::from).collect())
}

pub fn change_count(repo: &Path) -> Res<usize> {
    let st = status(repo)?;
    let paths: std::collections::HashSet<&str> =
        st.staged.iter().chain(&st.unstaged).chain(&st.conflicted).map(|f| f.path.as_str()).collect();
    Ok(paths.len())
}

fn scope_flag(scope: &str) -> Res<Option<&'static str>> {
    match scope {
        "global" => Ok(Some("--global")),
        "local" => Ok(Some("--local")),
        "effective" => Ok(None),
        _ => Err(format!("unknown config scope {scope}")),
    }
}

pub fn config_get(repo: &Path, key: &str, scope: &str) -> Res<Option<String>> {
    let mut args = vec!["config"];
    args.extend(scope_flag(scope)?);
    args.extend_from_slice(&["--get", key]);
    let out = read_allow(repo, &args, &[1])?;
    let value = out.trim_end_matches('\n');
    Ok((!value.is_empty()).then(|| value.to_string()))
}

/// An empty `value` unsets the key.
pub fn config_set(repo: &Path, key: &str, value: &str, scope: &str) -> Res<()> {
    let flag = scope_flag(scope)?.ok_or("choose the global or local scope")?;
    if value.is_empty() {
        spawn(repo, &["config", flag, "--unset", key], None, &[5]).map(drop)
    } else {
        run(repo, &["config", flag, key, value]).map(drop)
    }
}

pub fn version() -> Option<String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    let out = run(Path::new(&home), &["--version"]).ok()?;
    Some(out.trim().trim_start_matches("git version ").to_string())
}

const MAX_TEXT_FILE: u64 = 8 * 1024 * 1024;

/// Resolves `path` inside the worktree, rejecting paths that climb out of it.
pub fn worktree_path(repo: &Path, path: &str) -> Res<std::path::PathBuf> {
    let rel = Path::new(path);
    if rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("{path} is outside the repository"));
    }
    Ok(repo.join(rel))
}

pub fn read_text(repo: &Path, path: &str) -> Res<String> {
    let full = worktree_path(repo, path)?;
    let meta = std::fs::metadata(&full).map_err(|e| format!("{path}: {e}"))?;
    if meta.len() > MAX_TEXT_FILE {
        return Err(format!("{path} is too large to open here"));
    }
    let bytes = std::fs::read(&full).map_err(|e| format!("{path}: {e}"))?;
    if bytes.contains(&0) {
        return Err(format!("{path} is a binary file"));
    }
    String::from_utf8(bytes).map_err(|_| format!("{path} is not UTF-8 text"))
}

pub fn write_text(repo: &Path, path: &str, text: &str) -> Res<()> {
    std::fs::write(worktree_path(repo, path)?, text).map_err(|e| format!("{path}: {e}"))
}
