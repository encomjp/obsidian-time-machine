// Diff engine: line diff (Myers O(ND) with prefix/suffix trimming), hunking, word-level diff, stats.
// Pure TypeScript, no Obsidian imports.
import type { DiffLine, Hunk, Piece } from "./types.ts";

/**
 * Max edit distance explored by Myers before giving up. Beyond this the (trimmed) middle is reported as
 * "delete everything, add everything": still a correct diff, just not minimal. Bounds memory/time for
 * totally different huge inputs.
 */
const MAX_D = 4000;

/**
 * Split text into lines on /\r?\n/. Decision: "" has zero lines; otherwise a trailing newline yields a final
 * empty line, so "a\nb" vs "a\nb\n" is a real, minimal change (one added empty line) and identical texts
 * (including their trailing newline) are all "equal".
 */
export function splitLines(text: string): string[] {
  return text === "" ? [] : text.split(/\r?\n/);
}

type Op = 0 | 1 | 2; // 0 equal, 1 del (from a), 2 add (from b)

/** Edit script over two integer sequences. */
function myers(a: Int32Array | number[], b: Int32Array | number[]): Op[] {
  const n = a.length;
  const m = b.length;
  let start = 0;
  while (start < n && start < m && a[start] === b[start]) start++;
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push(0);
  const N = endA - start;
  const M = endB - start;
  if (N === 0 || M === 0) {
    for (let i = 0; i < N; i++) ops.push(1);
    for (let i = 0; i < M; i++) ops.push(2);
  } else {
    const mid = myersCore(a, start, N, b, start, M);
    for (let i = 0; i < mid.length; i++) ops.push(mid[i]!);
  }
  for (let i = endA; i < n; i++) ops.push(0);
  return ops;
}

function myersCore(a: ArrayLike<number>, ao: number, n: number, b: ArrayLike<number>, bo: number, m: number): Op[] {
  const max = Math.min(n + m, MAX_D);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)) x = v[off + k + 1]!;
      else x = v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[ao + x] === b[bo + y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) found = d;
    }
    const snap = new Int32Array(d + 1);
    for (let k = -d, i = 0; k <= d; k += 2, i++) snap[i] = v[off + k]!;
    trace.push(snap);
  }
  if (found < 0) {
    const out: Op[] = [];
    for (let i = 0; i < n; i++) out.push(1);
    for (let i = 0; i < m; i++) out.push(2);
    return out;
  }
  const rev: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1]!;
    const k = x - y;
    let pk: number;
    if (k === -d || (k !== d && prev[(k - 1 + d - 1) / 2]! < prev[(k + 1 + d - 1) / 2]!)) pk = k + 1;
    else pk = k - 1;
    const px = prev[(pk + d - 1) / 2]!;
    const py = px - pk;
    const mx = pk === k + 1 ? px : px + 1;
    const my = mx - k;
    while (x > mx) {
      rev.push(0);
      x--;
      y--;
    }
    rev.push(pk === k + 1 ? 2 : 1);
    x = px;
    y = py;
  }
  while (x > 0) {
    rev.push(0);
    x--;
  }
  rev.reverse();
  return rev;
}

function intern(lists: string[][]): Int32Array[] {
  const ids = new Map<string, number>();
  return lists.map((l) => {
    const out = new Int32Array(l.length);
    for (let i = 0; i < l.length; i++) {
      let id = ids.get(l[i]!);
      if (id === undefined) {
        id = ids.size;
        ids.set(l[i]!, id);
      }
      out[i] = id;
    }
    return out;
  });
}

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const [ia, ib] = intern([a, b]);
  const ops = myers(ia!, ib!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  for (const op of ops) {
    if (op === 0) {
      out.push({ kind: "equal", text: a[i]!, oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (op === 1) {
      out.push({ kind: "del", text: a[i]!, oldNo: i + 1 });
      i++;
    } else {
      out.push({ kind: "add", text: b[j]!, newNo: j + 1 });
      j++;
    }
  }
  return out;
}

export function toHunks(lines: DiffLine[], context = 3): Hunk[] {
  const hunks: Hunk[] = [];
  const ctx = Math.max(0, context);
  // next old/new line number at each index
  const oldAt: number[] = new Array(lines.length + 1);
  const newAt: number[] = new Array(lines.length + 1);
  let o = 1;
  let nw = 1;
  for (let i = 0; i < lines.length; i++) {
    oldAt[i] = o;
    newAt[i] = nw;
    if (lines[i]!.kind !== "add") o++;
    if (lines[i]!.kind !== "del") nw++;
  }
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.kind === "equal") {
      i++;
      continue;
    }
    const from = Math.max(0, i - ctx);
    let lastChange = i;
    let j = i + 1;
    // extend while the next change is within 2*ctx equal lines (contexts overlap/touch)
    while (j < lines.length && j - lastChange <= 2 * ctx + 1) {
      if (lines[j]!.kind !== "equal") lastChange = j;
      j++;
    }
    const to = Math.min(lines.length, lastChange + ctx + 1);
    hunks.push({ oldStart: oldAt[from]!, newStart: newAt[from]!, lines: lines.slice(from, to) });
    i = to;
  }
  return hunks;
}

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

function tokenize(s: string): string[] {
  return s.match(TOKEN) ?? [];
}

function pushPiece(arr: Piece[], kind: Piece["kind"], text: string): void {
  const last = arr[arr.length - 1];
  if (last && last.kind === kind) last.text += text;
  else arr.push({ kind, text });
}

export function diffWords(oldLine: string, newLine: string): { old: Piece[]; new: Piece[] } {
  const a = tokenize(oldLine);
  const b = tokenize(newLine);
  const [ia, ib] = intern([a, b]);
  const ops = myers(ia!, ib!);
  const o: Piece[] = [];
  const n: Piece[] = [];
  let i = 0;
  let j = 0;
  for (const op of ops) {
    if (op === 0) {
      pushPiece(o, "equal", a[i++]!);
      pushPiece(n, "equal", b[j++]!);
    } else if (op === 1) pushPiece(o, "del", a[i++]!);
    else pushPiece(n, "add", b[j++]!);
  }
  return { old: o, new: n };
}

export function stats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === "add") added++;
    else if (l.kind === "del") removed++;
  }
  return { added, removed };
}
