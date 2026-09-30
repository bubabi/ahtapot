use crate::git::{self, Res};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::time::Duration;
use tauri::ipc::Channel;

const MAX_PROMPT_BYTES: usize = 2_000_000;

const EXPLAIN: &str = "You explain git commits to a developer browsing history in a git client. \
Given a commit message and its diff, say in one or two sentences what the commit does and why, \
then list the notable changes as short '-' bullets that name the files or functions involved. \
Write plain text without headings or markdown emphasis, under 180 words.";

/// `protocol` is "anthropic" (Messages API) or "openai" (Chat Completions). `base_url`
/// includes the version segment, e.g. `https://api.anthropic.com/v1`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    provider: String,
    protocol: String,
    base_url: String,
    model: String,
    env_key: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum AiEvent {
    Text(String),
    Done,
}

/// Environment variables that name an API key and are inherited from the login shell.
pub const KEY_VARS: [&str; 5] = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY"];

fn env_key(name: Option<&str>) -> Option<String> {
    let name = name.filter(|n| KEY_VARS.contains(n))?;
    std::env::var(name).ok().filter(|k| !k.trim().is_empty())
}

fn account(provider: &str) -> Res<String> {
    if provider.is_empty() || !provider.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err(format!("invalid provider id {provider:?}"));
    }
    Ok(format!("{provider}-api-key"))
}

pub fn key_source(provider: &str, env: Option<&str>) -> Res<&'static str> {
    Ok(if env_key(env).is_some() {
        "env"
    } else if keychain::get(&account(provider)?).is_some() {
        "keychain"
    } else {
        "none"
    })
}

pub fn set_key(provider: &str, key: &str) -> Res<()> {
    keychain::set(&account(provider)?, key.trim())
}

pub fn clear_key(provider: &str) -> Res<()> {
    keychain::clear(&account(provider)?)
}

#[cfg(target_os = "macos")]
mod keychain {
    use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

    const SERVICE: &str = "io.github.bubabi.ahtapot";

    pub fn get(account: &str) -> Option<String> {
        get_generic_password(SERVICE, account).ok().and_then(|bytes| String::from_utf8(bytes).ok())
    }

    pub fn set(account: &str, key: &str) -> Result<(), String> {
        set_generic_password(SERVICE, account, key.as_bytes()).map_err(|e| e.to_string())
    }

    pub fn clear(account: &str) -> Result<(), String> {
        delete_generic_password(SERVICE, account).map_err(|e| e.to_string())
    }
}

#[cfg(not(target_os = "macos"))]
mod keychain {
    pub fn get(_account: &str) -> Option<String> {
        None
    }

    pub fn set(_account: &str, _key: &str) -> Result<(), String> {
        Err("Key storage is macOS-only; set the provider's *_API_KEY variable instead".into())
    }

    pub fn clear(_account: &str) -> Result<(), String> {
        Ok(())
    }
}

impl AiConfig {
    fn key(&self) -> Option<String> {
        env_key(self.env_key.as_deref()).or_else(|| keychain::get(&account(&self.provider).ok()?))
    }

    fn url(&self, path: &str) -> Res<String> {
        let base = self.base_url.trim().trim_end_matches('/');
        if base.is_empty() {
            return Err("Set the provider's base URL in Settings.".into());
        }
        Ok(format!("{base}/{path}"))
    }

    fn authorize<B>(&self, mut req: ureq::RequestBuilder<B>, key: Option<String>) -> Res<ureq::RequestBuilder<B>> {
        if self.protocol == "anthropic" {
            let key = key.ok_or("Add an Anthropic API key in Settings.")?;
            req = req.header("x-api-key", &key).header("anthropic-version", "2023-06-01");
        } else if let Some(key) = key {
            req = req.header("authorization", &format!("Bearer {key}"));
        }
        Ok(req)
    }
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(600)))
        .build()
        .into()
}

fn error_message(text: &str) -> String {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(String::from))
        .unwrap_or_else(|| text.trim().chars().take(300).collect())
}

fn check(response: ureq::http::Response<ureq::Body>) -> Res<ureq::Body> {
    let status = response.status().as_u16();
    let mut body = response.into_body();
    if status == 200 {
        return Ok(body);
    }
    let text = body.read_to_string().unwrap_or_default();
    Err(format!("{status}: {}", error_message(&text)))
}

pub fn models(config: &AiConfig) -> Res<Vec<String>> {
    let path = if config.protocol == "anthropic" { "models?limit=1000" } else { "models" };
    let req = config.authorize(agent().get(config.url(path)?), config.key())?;
    let response = req.call().map_err(|e| format!("Request failed: {e}"))?;
    let text = check(response)?.read_to_string().map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut ids: Vec<String> = value["data"]
        .as_array()
        .map(|list| list.iter().filter_map(|m| m["id"].as_str().map(String::from)).collect())
        .unwrap_or_default();
    ids.sort();
    Ok(ids)
}

fn message_system(limit: usize) -> String {
    format!(
        "You write git commit messages. Given the staged diff of a repository, write one commit message for it. \
The first line is a summary in the imperative mood, at most {limit} characters, with no trailing period. \
When the change needs explaining, add a blank line and a plain-text body that says what changed and why. \
Write each paragraph or list item on one line, without line breaks inside it. Do not invent reasons the diff does not show. Follow the style of the recent subjects \
when they share a convention. Reply with the commit message only, without quotes, code fences or markdown."
    )
}

fn commit_prompt(repo: &Path, sha: &str) -> Res<String> {
    let message = git::commit_message(repo, sha)?;
    let base = git::first_parent_or_empty(repo, sha)?;
    let stat = git::read(repo, &["diff", "--stat", "--no-color", &base, sha])?;
    let diff = git::read(repo, &["diff", "--no-color", "--no-ext-diff", "-M", &base, sha])?;
    Ok(format!("<message>\n{message}\n</message>\n\n<stat>\n{stat}</stat>\n\n<diff>\n{diff}</diff>"))
}

/// The staged changes, or with `amend` everything the amended HEAD commit would hold.
fn staged_prompt(repo: &Path, amend: bool) -> Res<String> {
    let base = if amend { git::first_parent_or_empty(repo, "HEAD")? } else { String::new() };
    let run = |stat: bool| {
        let mut args = vec!["diff", "--cached", "--no-color", "--no-ext-diff", "-M"];
        if stat {
            args.push("--stat");
        }
        if amend {
            args.push(&base);
        }
        git::read(repo, &args)
    };
    let stat = run(true)?;
    let diff = run(false)?;
    if diff.trim().is_empty() {
        return Err("Stage changes first.".into());
    }
    let subjects = git::read(repo, &["log", "-n", "10", "--format=%s"]).unwrap_or_default();
    Ok(format!("<recent_subjects>\n{subjects}</recent_subjects>\n\n<stat>\n{stat}</stat>\n\n<diff>\n{diff}</diff>"))
}

/// Streams an explanation of `sha` as text events.
pub fn explain(repo: &Path, sha: &str, config: &AiConfig, channel: &Channel<AiEvent>) -> Res<()> {
    stream(config, EXPLAIN, &commit_prompt(repo, sha)?, channel)
}

/// Streams a commit message for the staged changes as text events. `limit` caps the summary line.
pub fn commit_message(repo: &Path, amend: bool, limit: usize, config: &AiConfig, channel: &Channel<AiEvent>) -> Res<()> {
    stream(config, &message_system(limit), &staged_prompt(repo, amend)?, channel)
}

fn stream(config: &AiConfig, system: &str, prompt: &str, channel: &Channel<AiEvent>) -> Res<()> {
    if config.model.trim().is_empty() {
        return Err("Choose a model in Settings.".into());
    }
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err(format!("The diff is {:.1} MB, too large to send.", prompt.len() as f64 / 1e6));
    }
    let anthropic = config.protocol == "anthropic";
    let (path, body) = if anthropic {
        let body = json!({
            "model": config.model,
            "max_tokens": 4096,
            "stream": true,
            "system": system,
            "messages": [{ "role": "user", "content": prompt }],
        });
        ("messages", body)
    } else {
        let body = json!({
            "model": config.model,
            "stream": true,
            "messages": [{ "role": "system", "content": system }, { "role": "user", "content": prompt }],
        });
        ("chat/completions", body)
    };
    let req = config.authorize(agent().post(config.url(path)?), config.key())?;
    let response = req.send_json(&body).map_err(|e| format!("Request failed: {e}"))?;
    let reader = BufReader::new(check(response)?.into_reader());

    let mut stop = String::new();
    for line in reader.lines() {
        let line = line.map_err(|e| e.to_string())?;
        let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue };
        if data == "[DONE]" {
            break;
        }
        let Ok(event) = serde_json::from_str::<Value>(data) else { continue };
        if !event["error"].is_null() {
            return Err(error_message(data));
        }
        let text = if anthropic {
            if event["type"] == "message_delta" {
                stop = event["delta"]["stop_reason"].as_str().unwrap_or_default().to_string();
            }
            event["delta"]["text"].as_str().filter(|_| event["delta"]["type"] == "text_delta")
        } else {
            if let Some(reason) = event["choices"][0]["finish_reason"].as_str() {
                stop = reason.to_string();
            }
            event["choices"][0]["delta"]["content"].as_str()
        };
        if let Some(text) = text.filter(|t| !t.is_empty()) {
            let _ = channel.send(AiEvent::Text(text.to_string()));
        }
    }
    if stop == "refusal" || stop == "content_filter" {
        return Err("The model declined the request.".into());
    }
    let _ = channel.send(AiEvent::Done);
    Ok(())
}
