import { getCurrentWebview } from "@tauri-apps/api/webview";
import { AiSettings, DEFAULT_AI } from "./ai";
import { PullMode } from "./api";

export type Accent = "blue" | "purple" | "green" | "orange" | "pink";

export const APP_ICONS = ["dark", "light", "brand", "glass", "mono", "tinted", "depth", "glow"] as const;
export type AppIcon = (typeof APP_ICONS)[number];

/** An empty `value` or `color` means the default derived from the repository name. */
export interface ProjectTile {
  kind: "letters" | "emoji" | "icon";
  value: string;
  color: string;
}

export interface Settings {
  restoreLastRepo: boolean;
  autoFetchMinutes: number;
  fetchPrune: boolean;
  pullMode: PullMode;
  confirmDiscard: boolean;
  zoom: number;
  density: "comfortable" | "compact";
  tint: number;
  contentTint: number;
  accent: Accent;
  appIcon: AppIcon;
  uiFont: "instrument" | "system";
  monoFont: "jetbrains" | "sf" | "berkeley" | "menlo";
  dateFormat: "smart" | "relative" | "absolute";
  showBody: boolean;
  avatars: boolean;
  summaryLimit: number;
  signCommits: boolean;
  diffView: "unified" | "split";
  ignoreWhitespace: boolean;
  contextLines: number;
  syntax: boolean;
  wrap: boolean;
  tabSize: number;
  shell: string;
  termFontSize: number;
  termCursor: "block" | "bar" | "underline";
  editor: string;
  ai: AiSettings;
  loadouts: Record<string, Partial<Loadout>>;
  tiles: Record<string, ProjectTile>;
}

export const DEFAULTS: Settings = {
  restoreLastRepo: true,
  autoFetchMinutes: 10,
  fetchPrune: true,
  pullMode: "ff",
  confirmDiscard: true,
  zoom: 1,
  density: "comfortable",
  tint: 0.62,
  contentTint: 1,
  accent: "blue",
  appIcon: "dark",
  uiFont: "instrument",
  monoFont: "jetbrains",
  dateFormat: "smart",
  showBody: true,
  avatars: true,
  summaryLimit: 72,
  signCommits: false,
  diffView: "unified",
  ignoreWhitespace: false,
  contextLines: 3,
  syntax: true,
  wrap: true,
  tabSize: 4,
  shell: "",
  termFontSize: 12,
  termCursor: "block",
  editor: "",
  ai: DEFAULT_AI,
  loadouts: {},
  tiles: {},
};

/** Display settings a loadout captures. Git behavior, the editor, shell and AI provider stay out. */
export const LOADOUT_KEYS = [
  "accent",
  "tint",
  "contentTint",
  "zoom",
  "uiFont",
  "monoFont",
  "density",
  "dateFormat",
  "showBody",
  "avatars",
  "diffView",
  "syntax",
  "wrap",
  "tabSize",
  "termFontSize",
  "termCursor",
] as const;

export type Loadout = Pick<Settings, (typeof LOADOUT_KEYS)[number]>;

export function loadoutOf(s: Loadout): Loadout {
  return Object.fromEntries(LOADOUT_KEYS.map((k) => [k, s[k]])) as Loadout;
}

const base = loadoutOf(DEFAULTS);

export const BUILT_IN_LOADOUTS: Record<string, Loadout> = {
  Default: base,
  Compact: { ...base, density: "compact", zoom: 0.9, showBody: false, termFontSize: 11.5 },
  Glass: { ...base, tint: 0.4, contentTint: 0.72 },
  Solid: { ...base, tint: 1, contentTint: 1 },
  Large: { ...base, zoom: 1.2, termFontSize: 14 },
};

/** A saved loadout filled with defaults for keys added after it was saved. */
export const fullLoadout = (saved: Partial<Loadout>): Loadout => ({ ...base, ...saved });

export const sameLoadout = (a: Loadout, b: Loadout) => LOADOUT_KEYS.every((k) => a[k] === b[k]);

/** Fills fields missing from a stored object with defaults. */
export function normalize(raw: unknown): Settings {
  if (!raw || typeof raw !== "object") return DEFAULTS;
  const stored = raw as Partial<Settings>;
  return { ...DEFAULTS, ...stored, ai: { ...DEFAULT_AI, ...stored.ai }, loadouts: { ...stored.loadouts }, tiles: { ...stored.tiles } };
}

export function cachedSettings(): Settings {
  try {
    return normalize(JSON.parse(localStorage.getItem("ahtapot.settings") ?? "null"));
  } catch {
    return DEFAULTS;
  }
}

export const ACCENTS: Record<Accent, { label: string; color: string; strong: string }> = {
  blue: { label: "Blue", color: "#4d8dff", strong: "#0052ff" },
  purple: { label: "Purple", color: "#a970ff", strong: "#7c4dff" },
  green: { label: "Green", color: "#34d17d", strong: "#1f9d55" },
  orange: { label: "Orange", color: "#ffae3d", strong: "#d9820b" },
  pink: { label: "Pink", color: "#ff6ec7", strong: "#d9409c" },
};

const UI_FONTS = {
  instrument: '"Instrument Sans Variable", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  system: "-apple-system, BlinkMacSystemFont, system-ui, sans-serif",
};

const MONO_FONTS = {
  jetbrains: '"JetBrains Mono Variable", "SF Mono", ui-monospace, Menlo, monospace',
  sf: '"SF Mono", ui-monospace, Menlo, monospace',
  berkeley: '"Berkeley Mono", "JetBrains Mono Variable", "SF Mono", ui-monospace, Menlo, monospace',
  menlo: "Menlo, ui-monospace, monospace",
};

export const monoStack = (s: Settings) => MONO_FONTS[s.monoFont];

export const ROW = { comfortable: 28, compact: 24 } as const;

let appliedZoom = 1;

export function applyAppearance(s: Settings) {
  const root = document.documentElement.style;
  const accent = ACCENTS[s.accent] ?? ACCENTS.blue;
  root.setProperty("--accent", accent.color);
  root.setProperty("--accent-strong", accent.strong);
  root.setProperty("--tint", `rgba(12, 15, 20, ${s.tint})`);
  root.setProperty("--content", String(s.contentTint));
  root.setProperty("--sans", UI_FONTS[s.uiFont]);
  root.setProperty("--mono", MONO_FONTS[s.monoFont]);
  root.setProperty("--tab", String(s.tabSize));
  root.setProperty("--zoom", String(s.zoom));
  if (s.zoom !== appliedZoom) {
    appliedZoom = s.zoom;
    getCurrentWebview().setZoom(s.zoom).catch(() => {});
  }
}
