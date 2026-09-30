const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function shortTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return clock(d);
  if (d.getFullYear() === now.getFullYear()) return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatDate(ts: number, format: "smart" | "relative" | "absolute"): string {
  if (format === "relative") return relativeTime(ts);
  if (format === "absolute") {
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(d)}`;
  }
  return shortTime(ts);
}

/** Calendar date and clock time, shown as separate parts. */
export function dateParts(ts: number): [string, string] {
  const d = new Date(ts * 1000);
  return [`${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`, clock(d)];
}

export function relativeTime(ts: number): string {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo ago`;
  return `${Math.floor(s / (86400 * 365))}y ago`;
}

export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

const TILE_COLORS = ["#1f9d55", "#7c3aed", "#2563eb", "#d97706", "#db2777", "#0d9488", "#dc2626", "#4f46e5"];

export function hashColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return TILE_COLORS[Math.abs(h) % TILE_COLORS.length];
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
};

/** MIME type for raster image paths. SVG is left to the text diff. */
export function imageType(path: string): string | null {
  const name = path.split("/").pop() ?? "";
  return name.includes(".") ? (IMAGE_TYPES[name.split(".").pop()!.toLowerCase()] ?? null) : null;
}

export interface Match {
  score: number;
  ranges: [number, number][];
}

const BOUNDARY = /[\s/\-_.:@]/;

/**
 * Ranks `text` against space-separated query words; every word must match. Lower scores rank
 * higher: exact, then prefix, then word start, then substring, then letters in order.
 * `ranges` are the matched character spans.
 */
export function matchQuery(text: string, query: string): Match | null {
  const t = text.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, ranges: [] };
  if (t === q) return { score: -1, ranges: [[0, t.length]] };
  let score = t.length / 1000;
  const ranges: [number, number][] = [];
  for (const word of q.split(/\s+/)) {
    const at = t.indexOf(word);
    if (at >= 0) {
      score += at === 0 ? 0 : BOUNDARY.test(t[at - 1]) ? 1 : 2;
      ranges.push([at, at + word.length]);
      continue;
    }
    let from = 0;
    for (const ch of word) {
      const i = t.indexOf(ch, from);
      if (i < 0) return null;
      ranges.push([i, i + 1]);
      score += (i - from) / 10;
      from = i + 1;
    }
    score += 4;
  }
  return { score, ranges };
}

export const basename = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

export function splitPath(p: string): [string, string] {
  const i = p.lastIndexOf("/");
  return i === -1 ? ["", p] : [p.slice(0, i + 1), p.slice(i + 1)];
}

export function tildify(path: string, home: string): string {
  return home && path.startsWith(home) ? "~" + path.slice(home.length) : path;
}

const avatarCache = new Map<string, Promise<string | null>>();

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const FOUND = "ahtapot.avatars";

function found(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(FOUND) ?? "{}");
  } catch {
    return {};
  }
}

function remember(key: string, url: string) {
  try {
    localStorage.setItem(FOUND, JSON.stringify({ ...found(), [key]: url }));
  } catch {
    /* storage unavailable */
  }
}

/** Resolves to an image URL, or null when the address has no avatar. `fallback` runs after a Gravatar miss. */
export function avatarUrl(email: string, fallback?: () => Promise<string | null>): Promise<string | null> {
  const key = email.trim().toLowerCase();
  let hit = avatarCache.get(key);
  if (hit) return hit;
  const saved = found()[key];
  const github = /^(?:(\d+)\+)?([^@]+)@users\.noreply\.github\.com$/.exec(key);
  if (saved) {
    hit = Promise.resolve(saved);
  } else if (github) {
    const url = github[1]
      ? `https://avatars.githubusercontent.com/u/${github[1]}?s=64&v=4`
      : `https://github.com/${github[2]}.png?size=64`;
    hit = Promise.resolve(url);
  } else {
    hit = sha256(key).then((hash) => {
      const url = `https://gravatar.com/avatar/${hash}?s=64&d=404`;
      return new Promise<string | null>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(url);
        img.onerror = () => resolve(null);
        img.src = url;
      });
    }).then(async (url) => {
      if (url || !fallback) return url;
      const other = await fallback().catch(() => null);
      if (other) remember(key, other);
      return other;
    });
  }
  avatarCache.set(key, hit);
  return hit;
}

export interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
  leaf: boolean;
}

/** Builds a folder tree from slash-separated paths, collapsing single-child folder chains. */
export function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", children: [], leaf: false };
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const leaf = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.name === part && c.leaf === leaf);
      if (!child) {
        child = { name: part, path, children: [], leaf };
        node.children.push(child);
      }
      node = child;
    });
  }
  const compact = (n: TreeNode): TreeNode => {
    let cur = n;
    while (!cur.leaf && cur.children.length === 1 && !cur.children[0].leaf) {
      const only = cur.children[0];
      cur = { ...only, name: `${cur.name}/${only.name}` };
    }
    const children = cur.children.map(compact).sort((a, b) => Number(a.leaf) - Number(b.leaf) || a.name.localeCompare(b.name));
    return { ...cur, children };
  };
  return compact(root).children;
}
