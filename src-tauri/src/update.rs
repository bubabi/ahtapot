use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

/// Offers the latest GitHub release, if newer, and restarts into it once installed.
pub fn check(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let _ = prompt(app).await;
    });
}

async fn prompt(app: AppHandle) -> tauri_plugin_updater::Result<()> {
    let Some(update) = app.updater()?.check().await? else { return Ok(()) };
    let message = format!("Ahtapot {} is available. You have {}.", update.version, update.current_version);
    let handle = app.clone();
    app.dialog()
        .message(message)
        .title("Update available")
        .buttons(MessageDialogButtons::OkCancelCustom("Install and Restart".into(), "Later".into()))
        .show(move |accepted| {
            if !accepted {
                return;
            }
            tauri::async_runtime::spawn(async move {
                if update.download_and_install(|_, _| {}, || {}).await.is_ok() {
                    handle.restart();
                }
            });
        });
    Ok(())
}
