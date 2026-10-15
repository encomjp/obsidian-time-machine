import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, toHunks, diffWords, stats, splitLines } from "../src/diff.ts";
import type { DiffLine } from "../src/types.ts";

const oldSide = (d: DiffLine[]) => d.filter((l) => l.kind !== "add").map((l) => l.text);
const newSide = (d: DiffLine[]) => d.filter((l) => l.kind !== "del").map((l) => l.text);

test("equal inputs are all equal, with numbering", () => {
  const d = diffLines("a\nb\nc", "a\nb\nc");
  assert.deepEqual(d.map((l) => l.kind), ["equal", "equal", "equal"]);
  assert.deepEqual(d.map((l) => [l.oldNo, l.newNo]), [[1, 1], [2, 2], [3, 3]]);
  assert.deepEqual(toHunks(d), []);
  assert.deepEqual(diffLines("", ""), []);
});

test("pure add and pure delete", () => {
  const add = diffLines("a\nc", "a\nb\nc");
  assert.deepEqual(add.map((l) => l.kind), ["equal", "add", "equal"]);
  assert.equal(add[1]!.oldNo, undefined);
  assert.equal(add[1]!.newNo, 2);
  assert.deepEqual(stats(add), { added: 1, removed: 0 });
  const del = diffLines("a\nb\nc", "a\nc");
  assert.deepEqual(del.map((l) => l.kind), ["equal", "del", "equal"]);
  assert.equal(del[1]!.newNo, undefined);
  assert.equal(del[1]!.oldNo, 2);
  assert.deepEqual(stats(del), { added: 0, removed: 1 });
  assert.deepEqual(stats(diffLines("", "x\ny")), { added: 2, removed: 0 });
  assert.deepEqual(stats(diffLines("x\ny", "")), { added: 0, removed: 2 });
});

test("trailing newline is a minimal, real change", () => {
  const d = diffLines("a\nb", "a\nb\n");
  assert.deepEqual(d.map((l) => l.kind), ["equal", "equal", "add"]);
  assert.equal(d[2]!.text, "");
  assert.deepEqual(diffLines("a\n", "a\n").map((l) => l.kind), ["equal", "equal"]);
});

test("CRLF is treated as a line break", () => {
  assert.deepEqual(splitLines("a\r\nb\nc"), ["a", "b", "c"]);
  assert.deepEqual(stats(diffLines("a\r\nb", "a\nb")), { added: 0, removed: 0 });
});

test("move-ish edits", () => {
  const d = diffLines("a\nb\nc\nd\ne", "a\nd\nb\nc\ne");
  assert.deepEqual(stats(d), { added: 1, removed: 1 });
  assert.deepEqual(oldSide(d), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(newSide(d), ["a", "d", "b", "c", "e"]);
  const swap = diffLines("x\ny", "y\nx");
  assert.deepEqual(stats(swap), { added: 1, removed: 1 });
});

test("hunks: context, merging, none", () => {
  const old = Array.from({ length: 30 }, (_, i) => `l${i + 1}`);
  const nw = old.slice();
  nw[9] = "CHANGED10";
  nw[12] = "CHANGED13"; // 2 equal lines between: contexts overlap -> one hunk
  nw[25] = "CHANGED26";
  const d = diffLines(old.join("\n"), nw.join("\n"));
  const hs = toHunks(d, 3);
  assert.equal(hs.length, 2);
  assert.equal(hs[0]!.oldStart, 7);
  assert.equal(hs[0]!.newStart, 7);
  assert.equal(hs[0]!.lines[0]!.text, "l7");
  assert.equal(hs[0]!.lines.at(-1)!.text, "l16");
  assert.equal(hs[1]!.oldStart, 23);
  assert.equal(hs[1]!.lines.at(-1)!.text, "l29");
  // adjacent contexts (exactly 2*ctx equal lines between) merge too
  const e = diffLines("1\n2\n3\n4\n5\n6\n7\n8", "X\n2\n3\n4\n5\n6\n7\nY");
  assert.equal(toHunks(e, 3).length, 1);
  assert.equal(toHunks(e, 2).length, 2);
  assert.equal(toHunks(e, 0).length, 2);
  assert.deepEqual(toHunks(e, 0)[0]!.lines.map((l) => l.kind), ["del", "add"]);
});

test("hunk starts for pure add at top/with drift", () => {
  const d = diffLines("a\nb\nc\nd\ne\nf\ng\nh", "z\nz\na\nb\nc\nd\ne\nf\ng\nH");
  const hs = toHunks(d, 1);
  assert.equal(hs[0]!.oldStart, 1);
  assert.equal(hs[0]!.newStart, 1);
  assert.equal(hs[1]!.oldStart, 7);
  assert.equal(hs[1]!.newStart, 9);
});

test("diffWords", () => {
  const r = diffWords("the quick brown fox", "the slow brown  fox!");
  assert.deepEqual(r.old.filter((p) => p.kind === "add"), []);
  assert.deepEqual(r.new.filter((p) => p.kind === "del"), []);
  assert.equal(r.old.map((p) => p.text).join(""), "the quick brown fox");
  assert.equal(r.new.map((p) => p.text).join(""), "the slow brown  fox!");
  assert.ok(r.old.some((p) => p.kind === "del" && p.text === "quick"));
  assert.ok(r.new.some((p) => p.kind === "add" && p.text === "slow"));
  assert.deepEqual(diffWords("", ""), { old: [], new: [] });
  const u = diffWords("héllo wörld 😀", "héllo wörld 😀😀");
  assert.equal(u.new.map((p) => p.text).join(""), "héllo wörld 😀😀");
});

// seeded PRNG
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("randomized round-trip property (300 cases)", () => {
  const rand = rng(12345);
  const vocab = ["", "a", "b", "c", "dup", "dup", "héllo", "日本語", "😀 x", "  indent", "tab\tx", "the end"];
  const gen = () => {
    const len = Math.floor(rand() * 14);
    const parts: string[] = [];
    for (let i = 0; i < len; i++) parts.push(vocab[Math.floor(rand() * vocab.length)]!);
    const sep = rand() < 0.3 ? "\r\n" : "\n";
    return parts.join(sep) + (rand() < 0.3 ? sep : "");
  };
  const mutate = (t: string) => {
    const lines = t.split("\n");
    const k = Math.floor(rand() * 4);
    for (let i = 0; i < k; i++) {
      const p = Math.floor(rand() * (lines.length + 1));
      const r = rand();
      if (r < 0.4) lines.splice(p, 1);
      else if (r < 0.8) lines.splice(p, 0, vocab[Math.floor(rand() * vocab.length)]!);
      else if (p < lines.length) lines[p] = lines[p] + "!";
    }
    return lines.join("\n");
  };
  const cases: [string, string][] = [["", ""], ["", "a"], ["a", ""], ["", "\n"], ["\n", ""], ["\r\n", "\n"]];
  for (let i = 0; i < 300; i++) {
    const a = gen();
    cases.push([a, rand() < 0.5 ? gen() : mutate(a)]);
  }
  for (const [a, b] of cases) {
    const d = diffLines(a, b);
    assert.deepEqual(newSide(d), splitLines(b), JSON.stringify([a, b]));
    assert.deepEqual(oldSide(d), splitLines(a), JSON.stringify([a, b]));
    // numbering is consecutive on each side
    let o = 0;
    let n = 0;
    for (const l of d) {
      if (l.kind !== "add") assert.equal(l.oldNo, ++o);
      else assert.equal(l.oldNo, undefined);
      if (l.kind !== "del") assert.equal(l.newNo, ++n);
      else assert.equal(l.newNo, undefined);
    }
    // minimality vs LCS-free bound: changes never exceed total lines
    const s = stats(d);
    assert.ok(s.added + s.removed <= splitLines(a).length + splitLines(b).length);
    // hunks only contain lines from d and cover every change
    const hs = toHunks(d, 2);
    assert.equal(hs.reduce((c, h) => c + h.lines.filter((l) => l.kind !== "equal").length, 0), s.added + s.removed);
    if (a === b) assert.equal(hs.length, 0);
    // word diff round trip
    const w = diffWords(a, b);
    assert.equal(w.old.map((p) => p.text).join(""), a);
    assert.equal(w.new.map((p) => p.text).join(""), b);
    assert.ok(w.old.every((p) => p.kind !== "add") && w.new.every((p) => p.kind !== "del"));
  }
});

test("minimal diff on a known case", () => {
  const d = diffLines("a\nb\nc\na\nb\nb\na", "c\nb\na\nb\na\nc");
  assert.equal(stats(d).added + stats(d).removed, 5); // Myers paper example, D=5
});

test("large input, few edits: < 1s", () => {
  const lines = Array.from({ length: 20000 }, (_, i) => `line ${i} ${i % 7}`);
  const other = lines.slice();
  other[100] = "changed";
  other.splice(5000, 1);
  other.splice(15000, 0, "inserted");
  const t = performance.now();
  const d = diffLines(lines.join("\n"), other.join("\n"));
  const ms = performance.now() - t;
  assert.ok(ms < 1000, `took ${ms}ms`);
  assert.deepEqual(stats(d), { added: 2, removed: 2 });
  assert.deepEqual(newSide(d), other);
});

test("3k completely different lines: < 2s and still correct", () => {
  const a = Array.from({ length: 3000 }, (_, i) => `old ${i}`);
  const b = Array.from({ length: 3000 }, (_, i) => `new ${i}`);
  const t = performance.now();
  const d = diffLines(a.join("\n"), b.join("\n"));
  const ms = performance.now() - t;
  assert.ok(ms < 2000, `took ${ms}ms`);
  assert.deepEqual(stats(d), { added: 3000, removed: 3000 });
  assert.deepEqual(oldSide(d), a);
  assert.deepEqual(newSide(d), b);
});

test("huge totally different input degrades gracefully", () => {
  const a = Array.from({ length: 20000 }, (_, i) => `old ${i}`).join("\n");
  const b = Array.from({ length: 20000 }, (_, i) => `new ${i}`).join("\n");
  const t = performance.now();
  const d = diffLines(a, b);
  assert.ok(performance.now() - t < 3000);
  assert.deepEqual(oldSide(d), splitLines(a));
  assert.deepEqual(newSide(d), splitLines(b));
});
