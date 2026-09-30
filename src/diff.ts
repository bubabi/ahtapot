export interface DiffLine {
  kind: "ctx" | "add" | "del" | "meta";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface Hunk {
  header: string;
  lines: DiffLine[];
  raw: string[];
}

export interface FileDiff {
  header: string[];
  hunks: Hunk[];
  binary: boolean;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseDiff(text: string): FileDiff {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const header: string[] = [];
  const hunks: Hunk[] = [];
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of lines) {
    const m = HUNK.exec(line);
    if (m) {
      hunk = { header: line, lines: [], raw: [line] };
      hunks.push(hunk);
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      continue;
    }
    if (!hunk) {
      header.push(line);
      continue;
    }
    hunk.raw.push(line);
    const body = line.slice(1);
    switch (line[0]) {
      case "+":
        hunk.lines.push({ kind: "add", text: body, oldNo: null, newNo: newNo++ });
        break;
      case "-":
        hunk.lines.push({ kind: "del", text: body, oldNo: oldNo++, newNo: null });
        break;
      case "\\":
        hunk.lines.push({ kind: "meta", text: line, oldNo: null, newNo: null });
        break;
      default:
        hunk.lines.push({ kind: "ctx", text: body, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  const binary = header.some((l) => l.startsWith("Binary files") || l === "GIT binary patch");
  return { header, hunks, binary };
}

export function hunkPatch(diff: FileDiff, hunk: Hunk): string {
  return [...diff.header, ...hunk.raw].join("\n") + "\n";
}

/**
 * A patch holding only the `picked` line indexes of `hunk`. Unpicked lines on the side the
 * patch applies to become context, the rest are dropped. `reverse` builds it for `git apply --reverse`.
 * Line counts are left to `git apply --recount`.
 */
export function linesPatch(diff: FileDiff, hunk: Hunk, picked: Set<number>, reverse: boolean): string {
  const [, oldStart, newStart] = HUNK.exec(hunk.header)!;
  const body: string[] = [];
  let kept = false;
  hunk.lines.forEach((line, i) => {
    const raw = hunk.raw[i + 1];
    if (line.kind === "meta") {
      if (kept) body.push(raw);
      return;
    }
    kept = true;
    if (line.kind === "ctx" || picked.has(i)) body.push(raw);
    else if (line.kind === (reverse ? "add" : "del")) body.push(" " + line.text);
    else kept = false;
  });
  return [...diff.header, `@@ -${oldStart} +${newStart} @@`, ...body].join("\n") + "\n";
}

export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.kind === "ctx" || line.kind === "meta") {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    }
  }
  return rows;
}

/** Character range that differs between two paired lines, by common prefix and suffix. */
export function changedRange(a: string, b: string): [number, number, number, number] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return [start, endA, start, endB];
}
