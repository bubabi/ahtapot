import { Plus } from "@phosphor-icons/react";
import { useShallow } from "zustand/react/shallow";
import { actions, openMenu, openRepo, pickRepo, removeRepo, useStore } from "../store";
import { basename } from "../util";
import { RepoTile } from "./ProjectTile";

export function RepoRail() {
  const { repos, active, badges } = useStore(useShallow((s) => ({ repos: s.repos, active: s.active, badges: s.badges })));
  return (
    <nav className="rail">
      {repos.map((r) => {
        const count = badges[r] ?? 0;
        return (
          <button
            key={r}
            className={`rail-repo${r === active ? " active" : ""}`}
            title={r}
            onClick={() => r !== active && openRepo(r)}
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu(e.clientX, e.clientY, [
                { label: `Edit ${basename(r)} project…`, run: () => actions.editProject(r) },
                { separator: true, label: "" },
                { label: `Remove ${basename(r)} from list`, run: () => removeRepo(r), danger: true },
              ]);
            }}
          >
            <RepoTile path={r} size={32} />
            {count > 0 && <span className="badge">{count > 99 ? "99+" : count}</span>}
          </button>
        );
      })}
      {repos.length > 0 && <span className="rail-sep" />}
      <button className="rail-add" title="Open repository (⌘O)" onClick={pickRepo}>
        <Plus size={16} />
      </button>
    </nav>
  );
}
