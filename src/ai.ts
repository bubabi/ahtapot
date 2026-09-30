import { AiConfig } from "./api";

export interface Preset {
  id: string;
  label: string;
  protocol: "anthropic" | "openai";
  baseUrl: string;
  envKey: string | null;
  model: string;
  local?: boolean;
}

export const PRESETS: Preset[] = [
  { id: "anthropic", label: "Anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1", envKey: "ANTHROPIC_API_KEY", model: "claude-haiku-4-5" },
  { id: "openai", label: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1", envKey: "OPENAI_API_KEY", model: "" },
  { id: "openrouter", label: "OpenRouter", protocol: "openai", baseUrl: "https://openrouter.ai/api/v1", envKey: "OPENROUTER_API_KEY", model: "" },
  { id: "gemini", label: "Google Gemini", protocol: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", envKey: "GEMINI_API_KEY", model: "" },
  { id: "groq", label: "Groq", protocol: "openai", baseUrl: "https://api.groq.com/openai/v1", envKey: "GROQ_API_KEY", model: "" },
  { id: "ollama", label: "Ollama", protocol: "openai", baseUrl: "http://localhost:11434/v1", envKey: null, model: "", local: true },
  { id: "lmstudio", label: "LM Studio", protocol: "openai", baseUrl: "http://localhost:1234/v1", envKey: null, model: "", local: true },
  { id: "custom", label: "Custom (OpenAI-compatible)", protocol: "openai", baseUrl: "", envKey: null, model: "" },
];

export interface AiSettings {
  provider: string;
  configs: Record<string, { baseUrl?: string; model?: string }>;
}

export const DEFAULT_AI: AiSettings = { provider: "anthropic", configs: {} };

export const presetFor = (id: string) => PRESETS.find((p) => p.id === id) ?? PRESETS[0];

export function aiConfig(ai: AiSettings): AiConfig {
  const preset = presetFor(ai.provider);
  const saved = ai.configs[preset.id] ?? {};
  return {
    provider: preset.id,
    protocol: preset.protocol,
    baseUrl: saved.baseUrl ?? preset.baseUrl,
    model: saved.model ?? preset.model,
    envKey: preset.envKey,
  };
}
