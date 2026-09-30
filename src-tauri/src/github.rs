use crate::git;
use serde_json::Value;
use std::path::Path;
use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;

fn slug(url: &str) -> Option<&str> {
    let url = url.trim();
    let rest = ["https://github.com/", "git@github.com:", "ssh://git@github.com/"].iter().find_map(|p| url.strip_prefix(p))?;
    let slug = rest.trim_end_matches('/').trim_end_matches(".git");
    (slug.split('/').count() == 2).then_some(slug)
}

fn token() -> Option<String> {
    static TOKEN: OnceLock<Option<String>> = OnceLock::new();
    TOKEN
        .get_or_init(|| {
            let env = std::env::var("GITHUB_TOKEN").or_else(|_| std::env::var("GH_TOKEN")).ok();
            env.or_else(|| {
                let out = Command::new("gh").args(["auth", "token", "--hostname", "github.com"]).output().ok()?;
                let token = String::from_utf8(out.stdout).ok()?.trim().to_string();
                (out.status.success() && !token.is_empty()).then_some(token)
            })
        })
        .clone()
}

/// The avatar GitHub shows for `email`, looked up through that author's newest commit on a remote,
/// when `origin` is a github.com repository.
/// Authenticates with `GITHUB_TOKEN`, `GH_TOKEN` or the `gh` CLI login when available. Without one,
/// private repositories return nothing and calls are limited to 60 an hour.
pub fn avatar(repo: &Path, email: &str) -> Option<String> {
    let origin = git::read(repo, &["remote", "get-url", "origin"]).ok()?;
    let slug = slug(&origin)?;
    let author = format!("--author=<{email}>");
    let sha = git::read(repo, &["log", "-1", "-F", "-i", "--remotes", "--format=%H", &author]).ok()?;
    let sha = sha.trim();
    if sha.is_empty() {
        return None;
    }
    let url = format!("https://api.github.com/repos/{slug}/commits/{sha}");
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(10))).build().into();
    let mut req = agent.get(&url).header("user-agent", "Ahtapot").header("accept", "application/vnd.github+json");
    if let Some(token) = token() {
        req = req.header("authorization", &format!("Bearer {token}"));
    }
    let text = req.call().ok()?.into_body().read_to_string().ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value["author"]["avatar_url"].as_str().map(|u| format!("{u}&s=64"))
}
