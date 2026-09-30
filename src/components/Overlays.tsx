import { CheckCircle, Info, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../store";

export function ContextMenu() {
  const menu = useStore((s) => s.menu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - r.width - 8),
      y: Math.min(menu.y, window.innerHeight - r.height - 8),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e.type === "mousedown" && menu.anchor?.contains(e.target as Node)) return;
      useStore.setState({ menu: null });
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close(e);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  if (!menu) return null;
  return (
    <div ref={ref} className="menu" style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()}>
      {menu.items.map((item, i) =>
        item.separator ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            className={item.danger ? "danger" : undefined}
            disabled={item.disabled}
            onClick={() => {
              useStore.setState({ menu: null });
              item.run?.();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}

export function DialogHost() {
  const dialog = useStore((s) => s.dialog);
  const [value, setValue] = useState("");
  const [extra, setExtra] = useState("");
  const [check, setCheck] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (dialog?.kind === "prompt") {
      setValue(dialog.value);
      setExtra("");
      setCheck(dialog.check?.value ?? false);
      setTimeout(() => input.current?.select(), 0);
    }
  }, [dialog]);

  if (!dialog) return null;
  const close = () => useStore.setState({ dialog: null });
  const cancel = () => {
    if (dialog.kind === "prompt") dialog.resolve(null);
    else dialog.resolve(false);
    close();
  };
  const accept = () => {
    if (dialog.kind === "prompt") dialog.resolve({ value, check, extra });
    else dialog.resolve(true);
    close();
  };

  return (
    <div className="scrim" onMouseDown={cancel}>
      <form
        className="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          accept();
        }}
        onKeyDown={(e) => e.key === "Escape" && cancel()}
      >
        <h3>{dialog.title}</h3>
        {dialog.kind === "prompt" ? (
          <>
            {dialog.noInput ? (
              <p className="dialog-body">{dialog.label}</p>
            ) : (
              <>
                <label className="dialog-label">{dialog.label}</label>
                <input ref={input} className="field" value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} />
              </>
            )}
            {dialog.extra && (
              <>
                <label className="dialog-label">{dialog.extra.label}</label>
                <input className="field" value={extra} placeholder={dialog.extra.placeholder} onChange={(e) => setExtra(e.target.value)} spellCheck={false} />
              </>
            )}
            {dialog.check && (
              <label className="check">
                <input type="checkbox" checked={check} onChange={(e) => setCheck(e.target.checked)} />
                {dialog.check.label}
              </label>
            )}
          </>
        ) : (
          <p className="dialog-body">{dialog.body}</p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={cancel}>
            Cancel
          </button>
          <button type="submit" className={dialog.kind === "confirm" && dialog.danger ? "btn danger" : "btn primary"} autoFocus={dialog.kind === "confirm" || !!dialog.noInput}>
            {dialog.confirm}
          </button>
        </div>
      </form>
    </div>
  );
}

const NOTE_ICON = { ok: CheckCircle, error: WarningCircle, info: Info };

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => {
        const Icon = NOTE_ICON[t.kind];
        return (
          <div key={t.id} className={`toast ${t.kind}`}>
            <Icon size={15} />
            <span>{t.text}</span>
          </div>
        );
      })}
    </div>
  );
}
