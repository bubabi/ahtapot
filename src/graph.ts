export const WIP = "WIP";

export interface Seg {
  from: number;
  to: number;
  color: number;
  half: "top" | "bottom" | "full";
  dashed: boolean;
}

export interface GraphRow {
  lane: number;
  color: number;
  segs: Seg[];
  width: number;
  merge: boolean;
  avatar: boolean;
}

type Slot = { sha: string; color: number; dashed: boolean; email?: string } | null;

function firstFree(active: Slot[]): number {
  const i = active.indexOf(null);
  return i === -1 ? active.length : i;
}

/**
 * Assigns each commit a lane. Commits must be ordered children before parents.
 * Lanes keep their index for their whole life, so a freed lane leaves a gap until reused.
 */
export function layout(commits: { sha: string; parents: string[]; email?: string }[]): GraphRow[] {
  const active: Slot[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const incoming: number[] = [];
    active.forEach((slot, i) => {
      if (slot?.sha === commit.sha) incoming.push(i);
    });
    const lane = incoming.length ? incoming[0] : firstFree(active);
    const color = incoming.length ? active[lane]!.color : nextColor++;
    const avatar = !incoming.length || active[lane]!.email !== commit.email;

    const segs: Seg[] = [];
    active.forEach((slot, i) => {
      if (!slot) return;
      const into = slot.sha === commit.sha;
      segs.push({ from: i, to: into ? lane : i, color: slot.color, half: into ? "top" : "full", dashed: slot.dashed });
    });
    for (const i of incoming) active[i] = null;

    const [first, ...rest] = commit.parents;
    if (first) {
      const dashed = commit.sha === WIP;
      active[lane] = { sha: first, color, dashed, email: commit.email };
      segs.push({ from: lane, to: lane, color, half: "bottom", dashed });
      for (const parent of rest) {
        let k = active.findIndex((slot) => slot?.sha === parent);
        if (k === -1) {
          k = firstFree(active);
          active[k] = { sha: parent, color: nextColor++, dashed: false, email: commit.email };
        }
        segs.push({ from: lane, to: k, color: active[k]!.color, half: "bottom", dashed: false });
      }
    }
    while (active.length && active[active.length - 1] === null) active.pop();

    let width = lane + 1;
    for (const s of segs) width = Math.max(width, s.from + 1, s.to + 1);
    rows.push({ lane, color, segs, width, merge: commit.parents.length > 1, avatar });
  }
  return rows;
}

export const LANE_COLORS = [
  "#155fdf",
  "#9a63ec",
  "#21bc70",
  "#e13818",
  "#23aedd",
  "#ffae3d",
  "#ff6ec7",
  "#c6e04a",
  "#7a7cff",
  "#3fd9b0",
];

export const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length];
