import { Book, Brain, Browser, Bug, ChartBar, Cloud, Code, Cube, Database, DeviceMobile, Flask, Gear, Globe, type Icon, Lightning, Package, PaintBrush, Robot, Rocket, ShoppingCart, Smiley, Terminal } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { ProjectTile } from "../settings";
import { notify, updateSettings, useStore } from "../store";
import { basename, hashColor } from "../util";

const ICONS: Record<string, Icon> = { Code, Terminal, Browser, Globe, DeviceMobile, Database, Cloud, Cube, Package, Rocket, Lightning, Gear, Flask, Brain, Robot, Bug, Book, PaintBrush, ChartBar, ShoppingCart };

const COLORS = ["#dc2626", "#ea580c", "#d97706", "#65a30d", "#1f9d55", "#0d9488", "#0891b2", "#2563eb", "#4f46e5", "#7c3aed", "#db2777", "#475569"];

const TABS = [
  ["letters", "Letters"],
  ["symbol", "Icon"],
] as const;

const defaultLetters = (name: string) => name.slice(0, 2).toUpperCase();

function TileFace({ name, tile, size }: { name: string; tile?: ProjectTile; size: number }) {
  const Glyph = tile?.kind === "icon" ? ICONS[tile.value] : undefined;
  return (
    <span className="repo-tile" style={{ width: size, height: size, background: tile?.color || hashColor(name), fontSize: size * 0.42 }}>
      {Glyph ? (
        <Glyph size={Math.round(size * 0.55)} weight="bold" />
      ) : tile?.kind === "emoji" && tile.value ? (
        <span style={{ fontSize: size * 0.6 }}>{tile.value}</span>
      ) : (
        (tile?.kind === "letters" && tile.value) || defaultLetters(name)
      )}
    </span>
  );
}

export function RepoTile({ path, size = 18 }: { path: string; size?: number }) {
  const tile = useStore((s) => s.settings.tiles[path]);
  return <TileFace name={basename(path)} tile={tile} size={size} />;
}

export function ProjectEditor() {
  const path = useStore((s) => s.projectEdit);
  return path ? <Editor key={path} path={path} /> : null;
}

function Editor({ path }: { path: string }) {
  const saved = useStore.getState().settings.tiles[path];
  const name = basename(path);
  const [tab, setTab] = useState<"letters" | "symbol">(saved && saved.kind !== "letters" ? "symbol" : "letters");
  const [letters, setLetters] = useState(saved?.kind === "letters" ? saved.value : "");
  const [emoji, setEmoji] = useState(saved?.kind === "emoji" ? saved.value : "");
  const [icon, setIcon] = useState(saved?.kind === "icon" ? saved.value : "");
  const [color, setColor] = useState(saved?.color ?? "");
  const emojiField = useRef<HTMLInputElement>(null);
  const draft: ProjectTile = { kind: tab === "letters" ? "letters" : icon ? "icon" : "emoji", value: tab === "letters" ? letters : icon || emoji, color };
  const shown = color || hashColor(name);
  const isDefault = !draft.value && !color;

  const close = () => useStore.setState({ projectEdit: null });
  const save = () => {
    const { [path]: _, ...rest } = useStore.getState().settings.tiles;
    updateSettings({ tiles: isDefault ? rest : { ...rest, [path]: draft } });
    close();
  };
  const reset = () => {
    setTab("letters");
    setLetters("");
    setEmoji("");
    setIcon("");
    setColor("");
  };
  const pickEmoji = () => {
    emojiField.current?.focus();
    emojiField.current?.select();
    api.showEmojiPicker().catch((e) => notify("error", String(e)));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="scrim top" onMouseDown={close}>
      <form
        className="dialog project-dialog"
        aria-label={`Edit ${name} project`}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="pd-head">
          <TileFace name={name} tile={draft} size={40} />
          <div>
            <h3>{name}</h3>
            <span className="pd-path" title={path}>
              {path}
            </span>
          </div>
        </div>
        <div className="seg pd-tabs">
          {TABS.map(([key, label]) => (
            <button key={key} type="button" className={key === tab ? "on" : undefined} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </div>
        {tab === "letters" ? (
          <input className="field" value={letters} placeholder={defaultLetters(name)} maxLength={2} spellCheck={false} autoFocus onChange={(e) => setLetters(e.target.value.replace(/\s/g, "").toUpperCase())} />
        ) : (
          <>
            <div className="pd-emoji">
              <input
                ref={emojiField}
                className="field"
                value={emoji}
                placeholder="Pick or type an emoji"
                spellCheck={false}
                onChange={(e) => {
                  setEmoji(e.target.value.trim());
                  setIcon("");
                }}
              />
              <button type="button" className="icon-btn" title="Show emoji picker" onClick={pickEmoji}>
                <Smiley size={16} />
              </button>
            </div>
            <div className="pd-grid">
              {Object.entries(ICONS).map(([key, Glyph]) => (
                <button
                  key={key}
                  type="button"
                  title={key}
                  className={key === icon ? "on" : undefined}
                  onClick={() => {
                    setIcon(key);
                    setEmoji("");
                  }}
                >
                  <Glyph size={18} />
                </button>
              ))}
            </div>
          </>
        )}
        <label className="dialog-label">Color</label>
        <div className="swatches">
          {COLORS.map((c) => (
            <button key={c} type="button" className={`swatch${shown === c ? " on" : ""}`} style={{ background: c }} onClick={() => setColor(c)} />
          ))}
          <label className={`swatch custom${COLORS.includes(shown) ? "" : " on"}`} title="Custom color" style={COLORS.includes(shown) ? undefined : { background: shown }}>
            <input type="color" value={shown} onChange={(e) => setColor(e.target.value)} />
          </label>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn ghost pd-reset" disabled={isDefault} onClick={reset}>
            Reset
          </button>
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
