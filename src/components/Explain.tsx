import { Channel } from "@tauri-apps/api/core";
import { CircleNotch, Sparkle, X } from "@phosphor-icons/react";
import { FormEvent, useEffect, useState, useSyncExternalStore } from "react";
import { aiConfig, AiSettings, presetFor, PRESETS } from "../ai";
import { AiEvent, api, KeySource } from "../api";
import { updateSettings, useStore } from "../store";
import { ModelField } from "./ModelField";

interface Explanation {
  id: number;
  text: string;
  status: "running" | "done" | "error";
  error?: string;
}

const explanations = new Map<string, Explanation>();
const listeners = new Set<() => void>();
let runs = 0;

function put(sha: string, next: Explanation | null) {
  if (next) explanations.set(sha, next);
  else explanations.delete(sha);
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function explainCommit(repo: string, sha: string) {
  if (explanations.get(sha)?.status === "running") return;
  const config = aiConfig(useStore.getState().settings.ai);
  const id = ++runs;
  put(sha, { id, text: "", status: "running" });
  const channel = new Channel<AiEvent>();
  channel.onmessage = (event) => {
    const current = explanations.get(sha);
    if (current?.id !== id) return;
    if (event.kind === "text") put(sha, { ...current, text: current.text + event.data });
    else put(sha, { ...current, status: "done" });
  };
  api.aiExplain(repo, sha, config, channel).catch((e) => explanations.get(sha)?.id === id && put(sha, { id, text: "", status: "error", error: String(e) }));
}

export function ExplainCard({ sha }: { sha: string }) {
  const explanation = useSyncExternalStore(subscribe, () => explanations.get(sha));
  if (!explanation) return null;
  return (
    <div className={`explain${explanation.status === "error" ? " failed" : ""}`}>
      <div className="explain-head">
        <Sparkle size={13} />
        <span>AI explanation</span>
        {explanation.status === "running" && <CircleNotch size={13} className="spin" />}
        <span className="spacer" />
        <button className="icon-btn tiny" title="Remove explanation" onClick={() => put(sha, null)}>
          <X size={11} />
        </button>
      </div>
      <div className="explain-body">{explanation.status === "error" ? explanation.error : explanation.text || "Reading the diff…"}</div>
    </div>
  );
}

const SOURCE_TEXT: Record<KeySource, (env: string | null) => string> = {
  env: (env) => `Using $${env} from your shell.`,
  keychain: () => "Key saved in your Keychain.",
  none: () => "No key saved.",
};

function saveAi(ai: AiSettings) {
  updateSettings({ ai });
}

export function AiSettingsPanel() {
  const ai = useStore((s) => s.settings.ai);
  const config = aiConfig(ai);
  const preset = presetFor(ai.provider);
  const [source, setSource] = useState<KeySource | null>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loadSource = () => api.aiKeySource(preset.id, preset.envKey).then(setSource, (e) => setError(String(e)));
  useEffect(() => {
    setError(null);
    setSource(null);
    loadSource();
  }, [preset.id]);

  const patch = (change: { baseUrl?: string; model?: string }) =>
    saveAi({ ...ai, configs: { ...ai.configs, [preset.id]: { ...ai.configs[preset.id], ...change } } });

  const run = async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
    } catch (e) {
      setError(String(e));
    }
  };

  const saveKey = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await api.aiKeySet(preset.id, key);
      setKey("");
      await loadSource();
    });
  };

  return (
    <div className="ai-settings">
      <p className="st-note">The sparkle buttons explain a commit's diff and write commit messages for staged changes, using the provider below.</p>
      <label className="set-row">
        <span>Provider</span>
        <select className="field" value={preset.id} onChange={(e) => saveAi({ ...ai, provider: e.target.value })}>
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="set-row">
        <span>Base URL</span>
        <input className="field" value={config.baseUrl} placeholder="https://host/v1" onChange={(e) => patch({ baseUrl: e.target.value })} spellCheck={false} />
      </label>
      <div className="set-row">
        <span>API key</span>
        {source === "none" || source === null ? (
          <form className="inline" onSubmit={saveKey}>
            <input className="field" type="password" placeholder={preset.local ? "Not needed for local servers" : "Paste key"} value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} />
            <button className="btn small" disabled={!key.trim()}>
              Save
            </button>
          </form>
        ) : (
          <div className="inline">
            <span className="dim small grow">{SOURCE_TEXT[source](preset.envKey)}</span>
            {source === "keychain" && (
              <button
                className="btn small"
                onClick={() =>
                  run(async () => {
                    await api.aiKeyClear(preset.id);
                    await loadSource();
                  })
                }
              >
                Remove
              </button>
            )}
          </div>
        )}
      </div>
      <div className="set-row">
        <span>Model</span>
        <ModelField
          value={config.model}
          cacheKey={`${preset.id}|${config.baseUrl}|${source}`}
          fetch={() => api.aiModels(config)}
          onCommit={(model) => patch({ model })}
        />
      </div>
      {error && <div className="key-error">{error}</div>}
    </div>
  );
}
