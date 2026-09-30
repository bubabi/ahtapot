import { getVersion } from "@tauri-apps/api/app";
import { X } from "@phosphor-icons/react";
import { CSSProperties, ReactNode, useEffect, useState } from "react";
import { api, ConfigScope } from "../api";
import { Accent, ACCENTS, APP_ICONS, AppIcon, BUILT_IN_LOADOUTS, DEFAULTS, fullLoadout, loadoutOf, sameLoadout, Settings } from "../settings";
import { confirmDialog, notify, prompt, updateSettings, useStore } from "../store";
import { basename } from "../util";
import { AiSettingsPanel } from "./Explain";
import { applyTerminalSettings } from "./TerminalPane";

const SECTIONS = ["General", "Appearance", "Graph", "Diff", "Commit", "Terminal", "Identity", "AI", "Shortcuts", "About"] as const;
type Section = (typeof SECTIONS)[number];

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="st-row">
      <div className="st-label">
        <span>{label}</span>
        {hint && <span className="st-hint">{hint}</span>}
      </div>
      <div className="st-control">{children}</div>
    </div>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={value} className={`switch${value ? " on" : ""}`} onClick={() => onChange(!value)}>
      <span />
    </button>
  );
}

function Choice<T extends string | number>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <select className="field" value={String(value)} onChange={(e) => onChange(options.find(([v]) => String(v) === e.target.value)![0])}>
      {options.map(([v, label]) => (
        <option key={String(v)} value={String(v)}>
          {label}
        </option>
      ))}
    </select>
  );
}

function NumberField({ value, min, max, step = 1, suffix, onChange }: { value: number; min: number; max: number; step?: number; suffix?: string; onChange: (v: number) => void }) {
  return (
    <span className="num">
      <input
        className="field"
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
      />
      {suffix && <span className="dim">{suffix}</span>}
    </span>
  );
}

const ICON_URLS = import.meta.glob<string>("../../branding/icon-*.svg", { eager: true, query: "?url", import: "default" });
const ICON_LABELS: Record<AppIcon, string> = { dark: "Dark", light: "Light", brand: "Brand", glass: "Liquid Glass", mono: "Mono", tinted: "Tinted", depth: "Depth", glow: "Glow" };

function Tint({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const fill = { "--fill": `${((value - 0.3) / 0.7) * 100}%` } as CSSProperties;
  return (
    <span className="range">
      <input type="range" min={0.3} max={1} step={0.02} value={value} style={fill} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="range-value">{Math.round(value * 100)}%</span>
    </span>
  );
}

function TextField({ value, placeholder, onCommit }: { value: string; placeholder?: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className="field"
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft.trim())}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

function Identity() {
  const active = useStore((s) => s.active);
  const env = useStore((s) => s.env);
  const [values, setValues] = useState<Record<string, string>>({});
  const cwd = active ?? env?.home ?? "/";

  const load = async () => {
    const next: Record<string, string> = {};
    for (const scope of ["global", "local"] as ConfigScope[]) {
      if (scope === "local" && !active) continue;
      for (const key of ["user.name", "user.email"]) next[`${scope}:${key}`] = (await api.configGet(cwd, key, scope).catch(() => null)) ?? "";
    }
    setValues(next);
  };
  useEffect(() => {
    load();
  }, [active]);

  const save = (scope: ConfigScope, key: string) => async (value: string) => {
    try {
      await api.configSet(cwd, key, value, scope);
      notify("ok", value ? `Set ${key}` : `Cleared ${key}`);
      load();
    } catch (e) {
      notify("error", String(e));
    }
  };

  return (
    <>
      <div className="st-group">Global (~/.gitconfig)</div>
      <Row label="Name">
        <TextField value={values["global:user.name"] ?? ""} placeholder="Your Name" onCommit={save("global", "user.name")} />
      </Row>
      <Row label="Email">
        <TextField value={values["global:user.email"] ?? ""} placeholder="you@example.com" onCommit={save("global", "user.email")} />
      </Row>
      {active && (
        <>
          <div className="st-group">This repository ({basename(active)})</div>
          <Row label="Name" hint="Leave empty to use the global name.">
            <TextField value={values["local:user.name"] ?? ""} placeholder={values["global:user.name"] || "not set"} onCommit={save("local", "user.name")} />
          </Row>
          <Row label="Email" hint="Leave empty to use the global email.">
            <TextField value={values["local:user.email"] ?? ""} placeholder={values["global:user.email"] || "not set"} onCommit={save("local", "user.email")} />
          </Row>
        </>
      )}
    </>
  );
}

const SHORTCUTS: [string, string][] = [
  ["⌘K", "Command palette"],
  ["⌘,", "Settings"],
  ["⌘O", "Open repository"],
  ["⌘B", "Toggle sidebar"],
  ["⌘J", "Toggle terminal"],
  ["⌥⌘B", "Toggle details"],
  ["⌘R", "Refresh"],
  ["⇧⌘F", "Fetch all"],
  ["⇧⌘L", "Pull"],
  ["⇧⌘P", "Push"],
  ["⇧⌘B", "New branch"],
  ["⇧⌘S", "Stash changes"],
  ["⇧⌘E", "Open repository in editor"],
  ["⌘Z / ⇧⌘Z", "Undo / redo the last git action"],
  ["⌘↵", "Commit"],
  ["↑ ↓ or J K", "Move through commits"],
  ["Esc", "Close the diff"],
  ["⌘= / ⌘- / ⌘0", "Zoom in, out, reset"],
];

function About() {
  const env = useStore((s) => s.env);
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion().then(setVersion, () => {});
  }, []);
  return (
    <>
      <Row label="Ahtapot">{version || "…"}</Row>
      <Row label="git">{env?.gitVersion ?? "not found"}</Row>
      <Row label="Shell">{env?.shell}</Row>
      <Row label="Settings file" hint="Also holds repos.json and the undo journal.">
        <span className="mono dim">~/Library/Application Support/io.github.bubabi.ahtapot/settings.json</span>
      </Row>
    </>
  );
}

function Loadouts({ s }: { s: Settings }) {
  const saved = Object.keys(s.loadouts).sort((a, b) => a.localeCompare(b));
  const all: Record<string, Partial<Settings>> = { ...BUILT_IN_LOADOUTS, ...s.loadouts };
  const current = loadoutOf(s);
  const active = [...Object.keys(BUILT_IN_LOADOUTS), ...saved].find((name) => sameLoadout(current, fullLoadout(all[name]))) ?? "";

  const save = async () => {
    const result = await prompt("Save loadout", "Name", "Save", s.loadouts[active] ? active : "");
    const name = result?.value.trim();
    if (!name) return;
    if (BUILT_IN_LOADOUTS[name]) return notify("error", `${name} is a built-in loadout. Pick another name.`);
    updateSettings({ loadouts: { ...s.loadouts, [name]: current } });
    notify("ok", `Saved loadout ${name}`);
  };

  const remove = async () => {
    const ok = await confirmDialog("Delete loadout", `Delete the loadout "${active}"? Your current settings stay as they are.`, "Delete", true);
    if (!ok) return;
    const { [active]: _, ...rest } = s.loadouts;
    updateSettings({ loadouts: rest });
  };

  return (
    <span className="inline">
      <select className="field" value={active} onChange={(e) => updateSettings(fullLoadout(all[e.target.value]))}>
        {!active && <option value="">Custom</option>}
        <optgroup label="Built in">
          {Object.keys(BUILT_IN_LOADOUTS).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </optgroup>
        {saved.length > 0 && (
          <optgroup label="Saved">
            {saved.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <button className="btn small" onClick={save}>
        Save as…
      </button>
      {s.loadouts[active] && (
        <button className="btn small" onClick={remove}>
          Delete
        </button>
      )}
    </span>
  );
}

async function resetAll() {
  const ok = await confirmDialog(
    "Reset settings",
    "Restore every setting to its default? Saved loadouts and AI keys in the Keychain stay.",
    "Reset",
    true,
  );
  if (ok) updateSettings({ ...DEFAULTS, loadouts: useStore.getState().settings.loadouts });
}

function Body({ section, s }: { section: Section; s: Settings }) {
  const set = updateSettings;
  switch (section) {
    case "General":
      return (
        <>
          <Row label="Loadout" hint="Applies a saved look: colors, tints, zoom, fonts, density, diff and terminal display.">
            <Loadouts s={s} />
          </Row>
          <Row label="Reopen last repository" hint="Opens the repository you had open when Ahtapot quit.">
            <Toggle value={s.restoreLastRepo} onChange={(v) => set({ restoreLastRepo: v })} />
          </Row>
          <Row label="Fetch automatically" hint="Fetches all remotes of the open repository in the background.">
            <Choice value={s.autoFetchMinutes} options={[[0, "Never"], [1, "Every minute"], [5, "Every 5 minutes"], [10, "Every 10 minutes"], [30, "Every 30 minutes"]]} onChange={(v) => set({ autoFetchMinutes: v })} />
          </Row>
          <Row label="Prune on fetch" hint="Removes remote-tracking branches deleted on the server.">
            <Toggle value={s.fetchPrune} onChange={(v) => set({ fetchPrune: v })} />
          </Row>
          <Row label="Pull button" hint="What the toolbar pull button and ⇧⌘L run.">
            <Choice value={s.pullMode} options={[["ff", "Merge (fast-forward if possible)"], ["ff-only", "Fast-forward only"], ["rebase", "Rebase"]]} onChange={(v) => set({ pullMode: v })} />
          </Row>
          <Row label="Confirm before discarding" hint="Discards stay undoable with ⌘Z either way.">
            <Toggle value={s.confirmDiscard} onChange={(v) => set({ confirmDiscard: v })} />
          </Row>
          <Row label="External editor" hint={'A command such as code, cursor, zed or open -a "Sublime Text". Empty opens the default app.'}>
            <TextField value={s.editor} placeholder="Default app" onCommit={(v) => set({ editor: v })} />
          </Row>
          <Row label="Reset settings" hint="Restores every setting to its default. Saved loadouts and AI keys stay.">
            <button className="btn small" onClick={resetAll}>
              Reset all…
            </button>
          </Row>
        </>
      );
    case "Appearance":
      return (
        <>
          <Row label="Accent color">
            <div className="swatches">
              {(Object.keys(ACCENTS) as Accent[]).map((a) => (
                <button key={a} title={ACCENTS[a].label} className={`swatch${s.accent === a ? " on" : ""}`} style={{ background: ACCENTS[a].color }} onClick={() => set({ accent: a })} />
              ))}
            </div>
          </Row>
          <Row label="App icon" hint="Shown in the Dock while Ahtapot runs. Finder keeps the default.">
            <div className="icon-choices">
              {APP_ICONS.map((icon) => (
                <button key={icon} title={ICON_LABELS[icon]} aria-label={ICON_LABELS[icon]} className={`icon-choice${s.appIcon === icon ? " on" : ""}`} onClick={() => set({ appIcon: icon })}>
                  <img src={ICON_URLS[`../../branding/icon-${icon}.svg`]} alt="" draggable={false} />
                </button>
              ))}
            </div>
          </Row>
          <Row label="Frame tint" hint="Toolbar, repository rail and sidebar. Lower values show more of the desktop.">
            <Tint value={s.tint} onChange={(v) => set({ tint: v })} />
          </Row>
          <Row label="Content tint" hint="Graph, diff, commit details and terminal.">
            <Tint value={s.contentTint} onChange={(v) => set({ contentTint: v })} />
          </Row>
          <Row label="Zoom" hint="⌘= and ⌘- change it too.">
            <Choice value={s.zoom} options={[[0.8, "80%"], [0.9, "90%"], [1, "100%"], [1.1, "110%"], [1.2, "120%"], [1.3, "130%"]]} onChange={(v) => set({ zoom: v })} />
          </Row>
          <Row label="Interface font">
            <Choice value={s.uiFont} options={[["instrument", "Instrument Sans"], ["system", "SF Pro (system)"]]} onChange={(v) => set({ uiFont: v })} />
          </Row>
          <Row label="Monospace font" hint="Berkeley Mono falls back to JetBrains Mono when not installed.">
            <Choice value={s.monoFont} options={[["jetbrains", "JetBrains Mono"], ["sf", "SF Mono"], ["berkeley", "Berkeley Mono"], ["menlo", "Menlo"]]} onChange={(v) => set({ monoFont: v })} />
          </Row>
          <Row label="Author avatars" hint="Loads pictures from GitHub and Gravatar. Off shows initials only.">
            <Toggle value={s.avatars} onChange={(v) => set({ avatars: v })} />
          </Row>
        </>
      );
    case "Graph":
      return (
        <>
          <Row label="Row density">
            <Choice value={s.density} options={[["comfortable", "Comfortable (28 px)"], ["compact", "Compact (24 px)"]]} onChange={(v) => set({ density: v })} />
          </Row>
          <Row label="Dates">
            <Choice value={s.dateFormat} options={[["smart", "Time today, date otherwise"], ["relative", "Relative (3h ago)"], ["absolute", "Full (2026-09-29 14:05)"]]} onChange={(v) => set({ dateFormat: v })} />
          </Row>
          <Row label="Show commit body" hint="Prints the first body line after the subject.">
            <Toggle value={s.showBody} onChange={(v) => set({ showBody: v })} />
          </Row>
        </>
      );
    case "Diff":
      return (
        <>
          <Row label="Layout">
            <Choice value={s.diffView} options={[["unified", "Unified"], ["split", "Split"]]} onChange={(v) => set({ diffView: v })} />
          </Row>
          <Row label="Syntax highlighting">
            <Toggle value={s.syntax} onChange={(v) => set({ syntax: v })} />
          </Row>
          <Row label="Wrap long lines">
            <Toggle value={s.wrap} onChange={(v) => set({ wrap: v })} />
          </Row>
          <Row label="Ignore whitespace" hint="Hides whitespace-only changes. Hunk and line staging turn off while it is on.">
            <Toggle value={s.ignoreWhitespace} onChange={(v) => set({ ignoreWhitespace: v })} />
          </Row>
          <Row label="Context lines" hint="Unchanged lines shown around each change.">
            <NumberField value={s.contextLines} min={1} max={50} onChange={(v) => set({ contextLines: v })} />
          </Row>
          <Row label="Tab width">
            <NumberField value={s.tabSize} min={1} max={16} onChange={(v) => set({ tabSize: v })} suffix="spaces" />
          </Row>
        </>
      );
    case "Commit":
      return (
        <>
          <Row label="Summary length guide" hint="The counter under the summary turns red past this.">
            <NumberField value={s.summaryLimit} min={30} max={200} onChange={(v) => set({ summaryLimit: v })} suffix="characters" />
          </Row>
          <Row label="Sign commits" hint="Passes -S to git commit. Needs gpg or ssh signing set up in git config.">
            <Toggle value={s.signCommits} onChange={(v) => set({ signCommits: v })} />
          </Row>
        </>
      );
    case "Terminal":
      return (
        <>
          <Row label="Shell" hint="Empty uses $SHELL. Applies to new terminals.">
            <TextField value={s.shell} placeholder={useStore.getState().env?.shell ?? "/bin/zsh"} onCommit={(v) => set({ shell: v })} />
          </Row>
          <Row label="Font size">
            <NumberField value={s.termFontSize} min={9} max={24} step={0.5} suffix="px" onChange={(v) => set({ termFontSize: v })} />
          </Row>
          <Row label="Cursor">
            <Choice value={s.termCursor} options={[["block", "Block"], ["bar", "Bar"], ["underline", "Underline"]]} onChange={(v) => set({ termCursor: v })} />
          </Row>
        </>
      );
    case "Identity":
      return <Identity />;
    case "AI":
      return <AiSettingsPanel />;
    case "Shortcuts":
      return (
        <div className="shortcuts">
          {SHORTCUTS.map(([keys, what]) => (
            <div key={keys} className="st-row">
              <span>{what}</span>
              <kbd>{keys}</kbd>
            </div>
          ))}
        </div>
      );
    case "About":
      return <About />;
  }
}

export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen);
  const settings = useStore((s) => s.settings);
  const [section, setSection] = useState<Section>("General");

  useEffect(() => {
    applyTerminalSettings();
  }, [settings.termFontSize, settings.monoFont, settings.termCursor]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const combo = document.activeElement?.getAttribute("aria-expanded") === "true";
      if (e.key === "Escape" && !combo && !useStore.getState().dialog) useStore.setState({ settingsOpen: false });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;
  const close = () => useStore.setState({ settingsOpen: false });
  return (
    <div className="scrim" onMouseDown={close}>
      <div className="settings" role="dialog" aria-label="Settings" onMouseDown={(e) => e.stopPropagation()}>
        <nav className="st-nav">
          <div className="st-title">Settings</div>
          {SECTIONS.map((name) => (
            <button key={name} className={name === section ? "on" : ""} onClick={() => setSection(name)}>
              {name}
            </button>
          ))}
        </nav>
        <div className="st-body">
          <div className="st-head">
            <h2>{section}</h2>
            <button className="icon-btn" title="Close (Esc)" onClick={close}>
              <X size={15} />
            </button>
          </div>
          <div className="st-scroll">
            <Body section={section} s={settings} />
          </div>
        </div>
      </div>
    </div>
  );
}
