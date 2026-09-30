use crate::git;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher as _};
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct Watcher(Mutex<Option<RecommendedWatcher>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoChanged {
    path: String,
    refs: bool,
}

const DEBOUNCE: Duration = Duration::from_millis(350);

impl Watcher {
    pub fn watch(&self, app: AppHandle, root: PathBuf) -> Result<(), String> {
        let mut slot = self.0.lock().unwrap();
        *slot = None;
        let (tx, rx) = channel::<Event>();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            if let Ok(event) = res {
                let _ = tx.send(event);
            }
        })
        .map_err(|e| e.to_string())?;
        watcher.watch(&root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
        std::thread::spawn(move || debounce(app, root, rx));
        *slot = Some(watcher);
        Ok(())
    }
}

enum Kind {
    Ignore,
    Refs,
    GitDir,
    Worktree,
}

fn classify(root: &Path, path: &Path) -> Kind {
    let Ok(rel) = path.strip_prefix(root) else { return Kind::Ignore };
    let rel = rel.to_string_lossy();
    let Some(inner) = rel.strip_prefix(".git") else { return Kind::Worktree };
    let inner = inner.trim_start_matches('/');
    if inner.ends_with(".lock") || inner.starts_with("objects") || inner.starts_with("logs") {
        Kind::Ignore
    } else if inner == "HEAD" || inner.starts_with("refs") || inner == "packed-refs" {
        Kind::Refs
    } else {
        Kind::GitDir
    }
}

fn all_ignored(root: &Path, paths: &BTreeSet<String>) -> bool {
    let input: String = paths.iter().map(|p| format!("{p}\0")).collect();
    let Ok(out) = git::run_input(root, &["check-ignore", "-z", "--stdin"], input.as_bytes()) else {
        return false;
    };
    out.split('\0').filter(|s| !s.is_empty()).count() >= paths.len()
}

fn debounce(app: AppHandle, root: PathBuf, rx: Receiver<Event>) {
    while let Ok(first) = rx.recv() {
        let mut refs = false;
        let mut git_dir = false;
        let mut worktree = BTreeSet::new();
        let mut take = |event: Event| {
            for path in &event.paths {
                match classify(&root, path) {
                    Kind::Refs => refs = true,
                    Kind::GitDir => git_dir = true,
                    Kind::Worktree if worktree.len() < 256 => {
                        worktree.insert(path.strip_prefix(&root).unwrap().to_string_lossy().into_owned());
                    }
                    _ => {}
                }
            }
        };
        take(first);
        loop {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(event) => take(event),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        if !refs && !git_dir && (worktree.is_empty() || all_ignored(&root, &worktree)) {
            continue;
        }
        let payload = RepoChanged { path: root.to_string_lossy().into_owned(), refs };
        let _ = app.emit("repo-changed", payload);
    }
}
