mod ai;
#[cfg(target_os = "macos")]
mod dock;
mod git;
mod github;
mod ops;
mod pty;
mod update;
mod watch;

use git::{DiffOpts, Res};
use ops::{History, Journals, Op};
use pty::{PtyEvent, Ptys};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::ipc::Channel;
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use watch::Watcher;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

async fn mutate(app: AppHandle, repo: String, f: impl FnOnce(&Path) -> Res<Option<Op>> + Send + 'static) -> Res<()> {
    blocking(move || {
        let path = PathBuf::from(&repo);
        if let Some(op) = f(&path)? {
            app.state::<Journals>().record(&path, op);
        }
        Ok(())
    })
    .await
}

#[derive(Serialize, Deserialize, Default)]
struct RepoList {
    repos: Vec<String>,
    active: Option<String>,
}

fn config_file(app: &AppHandle, name: &str) -> Res<PathBuf> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Res<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[tauri::command]
fn repos_load(app: AppHandle) -> Res<RepoList> {
    let Ok(text) = std::fs::read_to_string(config_file(&app, "repos.json")?) else { return Ok(RepoList::default()) };
    Ok(serde_json::from_str(&text).unwrap_or_default())
}

#[tauri::command]
fn repos_save(app: AppHandle, list: RepoList) -> Res<()> {
    let text = serde_json::to_vec_pretty(&list).map_err(|e| e.to_string())?;
    write_atomic(&config_file(&app, "repos.json")?, &text)
}

#[tauri::command]
fn settings_load(app: AppHandle) -> Res<Value> {
    let Ok(text) = std::fs::read_to_string(config_file(&app, "settings.json")?) else { return Ok(Value::Null) };
    Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
}

#[tauri::command]
fn settings_save(app: AppHandle, settings: Value) -> Res<()> {
    let text = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    write_atomic(&config_file(&app, "settings.json")?, &text)
}

#[tauri::command]
async fn repo_resolve(path: String) -> Res<String> {
    blocking(move || git::toplevel(Path::new(&path)).map_err(|_| format!("{path} is not a git repository"))).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvInfo {
    user: String,
    host: String,
    home: String,
    shell: String,
    git_version: Option<String>,
    launch_repo: Option<String>,
}

#[tauri::command]
async fn env_info() -> Res<EnvInfo> {
    blocking(|| {
        let host = Command::new("hostname")
            .arg("-s")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        Ok(EnvInfo {
            user: std::env::var("USER").unwrap_or_default(),
            host,
            home: std::env::var("HOME").unwrap_or_default(),
            shell: std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()),
            git_version: git::version(),
            launch_repo: std::env::args().skip(1).find(|a| Path::new(a).is_dir()),
        })
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    status: git::Status,
    refs: Vec<git::Ref>,
    stashes: Vec<git::Stash>,
    remotes: Vec<String>,
    history: History,
}

#[tauri::command]
async fn snapshot(app: AppHandle, repo: String) -> Res<Snapshot> {
    blocking(move || {
        let path = Path::new(&repo);
        Ok(Snapshot {
            status: git::status(path)?,
            refs: git::refs(path)?,
            stashes: git::stashes(path)?,
            remotes: git::remotes(path)?,
            history: app.state::<Journals>().history(path),
        })
    })
    .await
}

#[tauri::command]
async fn change_count(repo: String) -> Res<usize> {
    blocking(move || git::change_count(Path::new(&repo))).await
}

#[tauri::command]
async fn log(repo: String, skip: usize, limit: usize) -> Res<Vec<git::Commit>> {
    blocking(move || git::log(Path::new(&repo), skip, limit)).await
}

#[tauri::command]
async fn log_position(repo: String, sha: String) -> Res<Option<usize>> {
    blocking(move || git::log_position(Path::new(&repo), &sha)).await
}

#[tauri::command]
async fn search_commits(repo: String, query: String, limit: usize) -> Res<Vec<git::Commit>> {
    blocking(move || git::search(Path::new(&repo), &query, limit)).await
}

#[tauri::command]
async fn commit_detail(repo: String, sha: String) -> Res<git::CommitDetail> {
    blocking(move || git::commit_detail(Path::new(&repo), &sha)).await
}

#[tauri::command]
async fn tree_files(repo: String, sha: String) -> Res<Vec<String>> {
    blocking(move || git::tree_files(Path::new(&repo), &sha)).await
}

#[tauri::command]
async fn diff_commit(repo: String, sha: String, path: String, orig_path: Option<String>, opts: DiffOpts) -> Res<String> {
    blocking(move || git::diff_commit(Path::new(&repo), &sha, &path, orig_path.as_deref(), opts)).await
}

#[tauri::command]
async fn diff_wip(repo: String, path: String, orig_path: Option<String>, staged: bool, untracked: bool, opts: DiffOpts) -> Res<String> {
    blocking(move || git::diff_wip(Path::new(&repo), &path, orig_path.as_deref(), staged, untracked, opts)).await
}

#[tauri::command]
async fn commit_message(repo: String, rev: String) -> Res<String> {
    blocking(move || git::commit_message(Path::new(&repo), &rev)).await
}

#[tauri::command]
async fn read_file(repo: String, path: String) -> Res<String> {
    blocking(move || git::read_text(Path::new(&repo), &path)).await
}

/// Raw bytes of `path` at `rev` ("" is the index), or in the worktree when `rev` is None.
#[tauri::command]
async fn read_blob(repo: String, rev: Option<String>, path: String) -> Res<tauri::ipc::Response> {
    blocking(move || {
        let root = Path::new(&repo);
        let bytes = match rev {
            Some(rev) => git::run_bytes(root, &["cat-file", "blob", &format!("{rev}:{path}")])?,
            None => std::fs::read(git::worktree_path(root, &path)?).map_err(|e| format!("{path}: {e}"))?,
        };
        if bytes.len() > 50 * 1024 * 1024 {
            return Err(format!("{path} is too large to preview"));
        }
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
}

#[tauri::command]
async fn write_file(repo: String, path: String, text: String) -> Res<()> {
    blocking(move || git::write_text(Path::new(&repo), &path, &text)).await
}

#[tauri::command]
async fn config_get(repo: String, key: String, scope: String) -> Res<Option<String>> {
    blocking(move || git::config_get(Path::new(&repo), &key, &scope)).await
}

#[tauri::command]
async fn config_set(repo: String, key: String, value: String, scope: String) -> Res<()> {
    blocking(move || git::config_set(Path::new(&repo), &key, &value, &scope)).await
}

#[tauri::command]
async fn commit(app: AppHandle, repo: String, message: String, amend: bool, sign: bool) -> Res<()> {
    mutate(app, repo, move |p| ops::commit(p, &message, amend, sign).map(Some)).await
}

#[tauri::command]
async fn checkout(app: AppHandle, repo: String, target: String, kind: String) -> Res<()> {
    mutate(app, repo, move |p| ops::checkout(p, &target, &kind).map(Some)).await
}

#[tauri::command]
async fn create_branch(app: AppHandle, repo: String, name: String, start: String, checkout: bool) -> Res<()> {
    mutate(app, repo, move |p| ops::create_branch(p, &name, &start, checkout).map(Some)).await
}

#[tauri::command]
async fn delete_branch(app: AppHandle, repo: String, name: String, force: bool) -> Res<()> {
    mutate(app, repo, move |p| ops::delete_branch(p, &name, force).map(Some)).await
}

#[tauri::command]
async fn rename_branch(app: AppHandle, repo: String, from: String, to: String) -> Res<()> {
    mutate(app, repo, move |p| ops::rename_branch(p, &from, &to).map(Some)).await
}

#[tauri::command]
async fn create_tag(app: AppHandle, repo: String, name: String, sha: String, message: String) -> Res<()> {
    mutate(app, repo, move |p| ops::create_tag(p, &name, &sha, &message).map(Some)).await
}

#[tauri::command]
async fn delete_tag(app: AppHandle, repo: String, name: String) -> Res<()> {
    mutate(app, repo, move |p| ops::delete_tag(p, &name).map(Some)).await
}

#[tauri::command]
async fn merge(app: AppHandle, repo: String, target: String, no_ff: bool) -> Res<()> {
    mutate(app, repo, move |p| ops::merge(p, &target, no_ff)).await
}

#[tauri::command]
async fn rebase(app: AppHandle, repo: String, onto: String) -> Res<()> {
    mutate(app, repo, move |p| ops::rebase(p, &onto)).await
}

#[tauri::command]
async fn cherry_pick(app: AppHandle, repo: String, sha: String) -> Res<()> {
    mutate(app, repo, move |p| ops::cherry_pick(p, &sha)).await
}

#[tauri::command]
async fn revert(app: AppHandle, repo: String, sha: String) -> Res<()> {
    mutate(app, repo, move |p| ops::revert(p, &sha)).await
}

#[tauri::command]
async fn reset(app: AppHandle, repo: String, sha: String, mode: String) -> Res<()> {
    mutate(app, repo, move |p| ops::reset(p, &sha, &mode)).await
}

#[tauri::command]
async fn sequence(app: AppHandle, repo: String, action: String) -> Res<()> {
    mutate(app, repo, move |p| ops::sequence(p, &action)).await
}

#[tauri::command]
async fn resolve(repo: String, path: String, side: String) -> Res<()> {
    blocking(move || ops::resolve(Path::new(&repo), &path, &side)).await
}

#[tauri::command]
async fn undo(app: AppHandle, repo: String) -> Res<String> {
    blocking(move || app.state::<Journals>().undo(Path::new(&repo))).await
}

#[tauri::command]
async fn redo(app: AppHandle, repo: String) -> Res<String> {
    blocking(move || app.state::<Journals>().redo(Path::new(&repo))).await
}

#[tauri::command]
async fn fetch(repo: String, remote: Option<String>, prune: bool) -> Res<()> {
    blocking(move || ops::fetch(Path::new(&repo), remote.as_deref(), prune)).await
}

#[tauri::command]
async fn pull(repo: String, mode: String) -> Res<()> {
    blocking(move || ops::pull(Path::new(&repo), &mode)).await
}

#[tauri::command]
async fn push(repo: String, force: bool, branch: Option<String>) -> Res<()> {
    blocking(move || ops::push(Path::new(&repo), force, branch.as_deref())).await
}

#[tauri::command]
async fn push_tag(repo: String, name: String) -> Res<()> {
    blocking(move || ops::push_tag(Path::new(&repo), &name)).await
}

#[tauri::command]
async fn delete_remote_branch(repo: String, target: String) -> Res<()> {
    blocking(move || ops::delete_remote_branch(Path::new(&repo), &target)).await
}

#[tauri::command]
async fn remote_add(repo: String, name: String, url: String) -> Res<()> {
    blocking(move || ops::remote_add(Path::new(&repo), &name, &url)).await
}

#[tauri::command]
async fn remote_remove(repo: String, name: String) -> Res<()> {
    blocking(move || ops::remote_remove(Path::new(&repo), &name)).await
}

#[tauri::command]
async fn stash_push(app: AppHandle, repo: String, message: String, untracked: bool) -> Res<()> {
    mutate(app, repo, move |p| ops::stash_push(p, &message, untracked).map(Some)).await
}

#[tauri::command]
async fn stash_apply(repo: String, pop: bool, index: u32) -> Res<()> {
    blocking(move || ops::stash_apply(Path::new(&repo), pop, index)).await
}

#[tauri::command]
async fn stash_drop(app: AppHandle, repo: String, index: u32) -> Res<()> {
    mutate(app, repo, move |p| ops::stash_drop(p, index).map(Some)).await
}

#[tauri::command]
async fn stage(repo: String, paths: Vec<String>) -> Res<()> {
    blocking(move || ops::stage(Path::new(&repo), &paths)).await
}

#[tauri::command]
async fn unstage(repo: String, paths: Vec<String>) -> Res<()> {
    blocking(move || ops::unstage(Path::new(&repo), &paths)).await
}

#[tauri::command]
async fn discard(app: AppHandle, repo: String, tracked: Vec<String>, untracked: Vec<String>) -> Res<()> {
    mutate(app, repo, move |p| ops::discard(p, &tracked, &untracked)).await
}

#[tauri::command]
async fn apply_patch(repo: String, patch: String, reverse: bool) -> Res<()> {
    blocking(move || ops::apply_patch(Path::new(&repo), &patch, true, reverse)).await
}

#[tauri::command]
async fn apply_worktree(app: AppHandle, repo: String, patch: String, reverse: bool, path: String) -> Res<()> {
    mutate(app, repo, move |p| ops::apply_worktree(p, &patch, reverse, &path)).await
}

/// Opens `path` (or the repository root) in `editor`, the system default app when empty,
/// or reveals it in Finder.
#[tauri::command]
async fn open_path(repo: String, path: Option<String>, editor: String, reveal: bool) -> Res<()> {
    blocking(move || {
        let root = Path::new(&repo);
        let full = match &path {
            Some(p) => git::worktree_path(root, p)?,
            None => root.to_path_buf(),
        };
        if reveal || editor.trim().is_empty() {
            let mut cmd = Command::new("open");
            if reveal {
                cmd.arg("-R");
            }
            let out = cmd.arg(&full).stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
            return Ok(());
        }
        let mut child = Command::new("/bin/sh")
            .args(["-c", &format!("{} \"$@\"", editor.trim()), "sh"])
            .arg(&full)
            .current_dir(root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("could not run {editor}: {e}"))?;
        std::thread::spawn(move || child.wait());
        Ok(())
    })
    .await
}

#[tauri::command]
async fn ai_explain(repo: String, sha: String, config: ai::AiConfig, on_event: Channel<ai::AiEvent>) -> Res<()> {
    blocking(move || ai::explain(Path::new(&repo), &sha, &config, &on_event)).await
}

#[tauri::command]
async fn ai_commit_message(repo: String, amend: bool, limit: usize, config: ai::AiConfig, on_event: Channel<ai::AiEvent>) -> Res<()> {
    blocking(move || ai::commit_message(Path::new(&repo), amend, limit, &config, &on_event)).await
}

#[tauri::command]
fn set_app_icon(app: AppHandle, style: String) -> Res<()> {
    #[cfg(target_os = "macos")]
    app.run_on_main_thread(move || dock::set_icon(&style)).map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    let _ = (app, style);
    Ok(())
}

#[tauri::command]
fn show_emoji_picker(app: AppHandle) -> Res<()> {
    #[cfg(target_os = "macos")]
    app.run_on_main_thread(|| {
        if let Some(mtm) = objc2::MainThreadMarker::new() {
            objc2_app_kit::NSApplication::sharedApplication(mtm).orderFrontCharacterPalette(None);
        }
    })
    .map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}

#[tauri::command]
async fn github_avatar(repo: String, email: String) -> Res<Option<String>> {
    blocking(move || Ok(github::avatar(Path::new(&repo), &email))).await
}

#[tauri::command]
async fn ai_models(config: ai::AiConfig) -> Res<Vec<String>> {
    blocking(move || ai::models(&config)).await
}

#[tauri::command]
async fn ai_key_source(provider: String, env_key: Option<String>) -> Res<&'static str> {
    blocking(move || ai::key_source(&provider, env_key.as_deref())).await
}

#[tauri::command]
async fn ai_key_set(provider: String, key: String) -> Res<()> {
    blocking(move || ai::set_key(&provider, &key)).await
}

#[tauri::command]
async fn ai_key_clear(provider: String) -> Res<()> {
    blocking(move || ai::clear_key(&provider)).await
}

#[tauri::command]
fn watch_repo(app: AppHandle, watcher: State<'_, Watcher>, repo: String) -> Res<()> {
    watcher.watch(app, PathBuf::from(repo))
}

#[tauri::command]
fn pty_spawn(ptys: State<'_, Ptys>, cwd: String, shell: Option<String>, cols: u16, rows: u16, on_event: Channel<PtyEvent>) -> Res<u32> {
    ptys.spawn(&cwd, shell.as_deref(), cols, rows, on_event)
}

#[tauri::command]
fn pty_write(ptys: State<'_, Ptys>, id: u32, data: String) -> Res<()> {
    ptys.write(id, &data)
}

#[tauri::command]
fn pty_resize(ptys: State<'_, Ptys>, id: u32, cols: u16, rows: u16) -> Res<()> {
    ptys.resize(id, cols, rows)
}

#[tauri::command]
fn pty_kill(ptys: State<'_, Ptys>, id: u32) {
    ptys.kill(id);
}

/// Finder launches apps with a minimal environment, which hides gpg, git-lfs and
/// credential helpers from git, and any provider API keys exported by the shell profile.
fn inherit_login_env() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let script: String = std::iter::once("PATH")
        .chain(ai::KEY_VARS)
        .map(|name| format!("printf '\\n__ahtapot_{name}=%s' \"${name}\";"))
        .collect();
    let Ok(out) = Command::new(shell).args(["-lc", &script]).output() else { return };
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let Some((name, value)) = line.strip_prefix("__ahtapot_").and_then(|l| l.split_once('=')) else { continue };
        let keep_existing = name != "PATH" && std::env::var_os(name).is_some();
        if !value.is_empty() && !keep_existing {
            std::env::set_var(name, value);
        }
    }
}

/// Menu item ids are emitted to the webview as `menu` events.
fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, label: &str, accel: Option<&str>| MenuItem::with_id(app, id, label, true, accel);
    let sep = || PredefinedMenuItem::separator(app);
    let about = AboutMetadata { name: Some("Ahtapot".into()), version: Some(app.package_info().version.to_string()), ..Default::default() };
    let app_menu = Submenu::with_items(
        app,
        "Ahtapot",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Ahtapot"), Some(about))?,
            &sep()?,
            &item("settings", "Settings…", Some("CmdOrCtrl+,"))?,
            &sep()?,
            &PredefinedMenuItem::services(app, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item("open", "Open Repository…", Some("CmdOrCtrl+O"))?,
            &item("reveal", "Reveal in Finder", None)?,
            &item("editor", "Open in Editor", Some("CmdOrCtrl+Shift+E"))?,
            &sep()?,
            &item("remove-repo", "Remove Repository from List", None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item("palette", "Command Palette…", Some("CmdOrCtrl+K"))?,
            &item("sidebar", "Toggle Sidebar", Some("CmdOrCtrl+B"))?,
            &item("details", "Toggle Details", Some("CmdOrCtrl+Alt+B"))?,
            &item("terminal", "Toggle Terminal", Some("CmdOrCtrl+J"))?,
            &sep()?,
            &item("zoom-in", "Zoom In", Some("CmdOrCtrl+="))?,
            &item("zoom-out", "Zoom Out", Some("CmdOrCtrl+-"))?,
            &item("zoom-reset", "Actual Size", Some("CmdOrCtrl+0"))?,
            &sep()?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let repository = Submenu::with_items(
        app,
        "Repository",
        true,
        &[
            &item("refresh", "Refresh", Some("CmdOrCtrl+R"))?,
            &item("fetch", "Fetch All", Some("CmdOrCtrl+Shift+F"))?,
            &item("pull", "Pull", Some("CmdOrCtrl+Shift+L"))?,
            &item("push", "Push", Some("CmdOrCtrl+Shift+P"))?,
            &sep()?,
            &item("branch", "New Branch…", Some("CmdOrCtrl+Shift+B"))?,
            &item("stash", "Stash Changes…", Some("CmdOrCtrl+Shift+S"))?,
            &item("pop", "Pop Stash", None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &sep()?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &repository, &window])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    inherit_login_env();
    tauri::Builder::default()
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Ptys::default())
        .manage(Watcher::default())
        .menu(build_menu)
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().0.clone());
        })
        .setup(|app| {
            let file = config_file(app.handle(), "journal.json")?;
            app.manage(Journals::load(file));
            update::check(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            repos_load,
            repos_save,
            settings_load,
            settings_save,
            repo_resolve,
            env_info,
            snapshot,
            change_count,
            log,
            log_position,
            search_commits,
            commit_detail,
            tree_files,
            diff_commit,
            diff_wip,
            commit_message,
            read_file,
            read_blob,
            write_file,
            config_get,
            config_set,
            commit,
            checkout,
            create_branch,
            delete_branch,
            rename_branch,
            create_tag,
            delete_tag,
            merge,
            rebase,
            cherry_pick,
            revert,
            reset,
            sequence,
            resolve,
            undo,
            redo,
            fetch,
            pull,
            push,
            push_tag,
            delete_remote_branch,
            remote_add,
            remote_remove,
            stash_push,
            stash_apply,
            stash_drop,
            stage,
            unstage,
            discard,
            apply_patch,
            apply_worktree,
            open_path,
            ai_explain,
            ai_commit_message,
            ai_models,
            github_avatar,
            set_app_icon,
            show_emoji_picker,
            ai_key_source,
            ai_key_set,
            ai_key_clear,
            watch_repo,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
