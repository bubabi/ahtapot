use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::ipc::Channel;

#[derive(Clone, Serialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum PtyEvent {
    Data(String),
    Exit,
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Ptys {
    next: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }
}

/// Forwards PTY bytes as UTF-8 text. A multi-byte sequence split across reads is
/// carried into the next chunk instead of being replaced.
fn pump(mut reader: Box<dyn Read + Send>, channel: Channel<PtyEvent>) {
    let mut buf = [0u8; 16 * 1024];
    let mut carry: Vec<u8> = Vec::new();
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        carry.extend_from_slice(&buf[..n]);
        let valid = match std::str::from_utf8(&carry) {
            Ok(_) => carry.len(),
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            Err(_) => carry.len(),
        };
        let text = String::from_utf8_lossy(&carry[..valid]).into_owned();
        carry.drain(..valid);
        if !text.is_empty() && channel.send(PtyEvent::Data(text)).is_err() {
            break;
        }
    }
    let _ = channel.send(PtyEvent::Exit);
}

impl Ptys {
    /// `shell` overrides `$SHELL` when it is non-empty.
    pub fn spawn(&self, cwd: &str, shell: Option<&str>, cols: u16, rows: u16, channel: Channel<PtyEvent>) -> Result<u32, String> {
        let pair = native_pty_system().openpty(size(cols, rows)).map_err(|e| e.to_string())?;
        let shell = match shell.map(str::trim).filter(|s| !s.is_empty()) {
            Some(s) => s.to_string(),
            None => std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()),
        };
        let mut cmd = CommandBuilder::new(shell);
        cmd.arg("-l");
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        std::thread::spawn(move || pump(reader, channel));
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.sessions.lock().unwrap().insert(id, Session { master: pair.master, writer, child });
        Ok(id)
    }

    pub fn write(&self, id: u32, data: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions.get_mut(&id).ok_or("no such terminal")?;
        session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions.get(&id).ok_or("no such terminal")?;
        session.master.resize(size(cols, rows)).map_err(|e| e.to_string())
    }

    pub fn kill(&self, id: u32) {
        if let Some(mut session) = self.sessions.lock().unwrap().remove(&id) {
            let _ = session.child.kill();
        }
    }
}
