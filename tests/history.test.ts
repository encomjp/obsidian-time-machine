import { test } from "node:test";
import assert from "node:assert/strict";
import { History, MemoryStorage } from "../src/history.ts";
import type { Policy } from "../src/types.ts";

const fnv = async (t: string): Promise<string> => {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0") + ":" + t.length;
};

const H = 3600 * 1000;
const D = 24 * H;
const mk = () => {
  const s = new MemoryStorage();
  return { s, h: new History(s, fnv) };
};

test("dedupe identical content; returning to old content records, blob shared", async () => {
  const { s, h } = mk();
  assert.equal(await h.record("a.md", "one", 1), true);
  assert.equal(await h.record("a.md", "one", 2), false);
  assert.equal(await h.record("a.md", "two", 3), true);
  assert.equal(await h.record("a.md", "one", 4), true);
  assert.equal(h.versionsOf("a.md").length, 3);
  assert.equal(s.texts.size, 2);
  assert.deepEqual(h.versionsOf("a.md").map((v) => v.time), [4, 3, 1]);
  assert.equal(await h.text(h.versionsOf("a.md")[0]!), "one");
});

test("deletion and recreation", async () => {
  const { h } = mk();
  assert.equal(await h.record("a", null, 1), false);
  await h.record("a", "x", 2);
  assert.equal(await h.record("a", null, 3), true);
  assert.equal(await h.record("a", null, 4), false);
  assert.equal(await h.record("a", "x", 5), true);
  const vs = h.versionsOf("a");
  assert.equal(vs.length, 3);
  assert.equal(vs[1]!.hash, null);
  assert.equal(await h.text(vs[1]!), null);
});

test("stateAt", async () => {
  const { h } = mk();
  await h.record("a", "1", 10);
  await h.record("a", "22", 20);
  await h.record("b", "b", 15);
  await h.record("b", null, 25);
  assert.equal(h.stateAt(5).size, 0);
  assert.equal(h.stateAt(10).get("a")?.size, 1);
  assert.equal(h.stateAt(17).size, 2);
  assert.equal(h.stateAt(20).get("a")?.size, 2);
  assert.deepEqual([...h.stateAt(30).keys()], ["a"]);
});

test("changedBetween", async () => {
  const { h } = mk();
  await h.record("keep", "k", 1);
  await h.record("mod", "m1", 1);
  await h.record("del", "d", 1);
  await h.record("mod", "m2", 5);
  await h.record("del", null, 5);
  await h.record("add", "a", 5);
  await h.record("keep", "k2", 3);
  await h.record("keep", "k", 4); // back to same content
  const c = h.changedBetween(2, 6);
  assert.deepEqual(c.map((x) => x.path), ["add", "del", "mod"]);
  const by = Object.fromEntries(c.map((x) => [x.path, x]));
  assert.equal(by.add!.before, null);
  assert.ok(by.add!.after);
  assert.ok(by.del!.before);
  assert.equal(by.del!.after, null);
  assert.ok(by.mod!.before && by.mod!.after);
  assert.deepEqual(h.changedBetween(6, 6), []);
});

test("corrupt log tolerated", async () => {
  for (const bad of ["garbage", 42, { a: 1 }, [null, 1, "x", { path: 1 }, { path: "a", time: "x", hash: "h", size: 1 },
    { path: "a", time: 1, hash: 5, size: 1 }, { path: "a", time: 1 }, { path: "a", time: NaN, hash: null }]]) {
    const s = new MemoryStorage();
    await s.writeJson("log", bad);
    const h = new History(s, fnv);
    await h.load();
    assert.equal(h.totals().versions, 0);
  }
  const s = new MemoryStorage();
  await s.writeJson("log", [
    { path: "b", hash: "x", time: 9, size: 3 },
    { path: "bad" },
    { path: "a", hash: null, time: 2, size: 0 },
  ]);
  const h = new History(s, fnv);
  await h.load();
  assert.deepEqual(h.range(), { first: 2, last: 9 });
  assert.equal(h.totals().versions, 2);
});

test("persistence round trip, lazy flush", async () => {
  const { s, h } = mk();
  await h.record("a", "x", 1);
  await h.record("a", "y", 2);
  assert.equal(s.json.has("log"), false);
  await h.flush();
  assert.equal(s.json.has("log"), true);
  const h2 = new History(s, fnv);
  await h2.load();
  assert.deepEqual(h2.versionsOf("a"), h.versionsOf("a"));
  assert.equal(await h2.text(h2.versionsOf("a")[0]!), "y");
  assert.equal(await h2.record("a", "y", 3), false);
});

test("range and totals", async () => {
  const { h } = mk();
  assert.equal(h.range(), null);
  await h.record("a", "abc", 5);
  await h.record("b", "abc", 7);
  await h.record("c", "de", 3);
  assert.deepEqual(h.range(), { first: 3, last: 7 });
  const t = h.totals();
  assert.equal(t.versions, 3);
  assert.equal(t.paths, 3);
  assert.equal(t.bytes, 5);
  assert.deepEqual(h.paths().sort(), ["a", "b", "c"]);
});

test("activity buckets", async () => {
  const { h } = mk();
  await h.record("a", "1", 0);
  await h.record("a", "2", 24);
  await h.record("a", "3", 25);
  await h.record("a", "4", 50);
  await h.record("a", "5", 100);
  await h.record("a", "6", 101);
  assert.deepEqual(h.activity(4, 0, 100), [2, 1, 1, 1]);
  assert.deepEqual(h.activity(1, 0, 100), [5]);
  assert.deepEqual(h.activity(0, 0, 100), []);
  assert.deepEqual(h.activity(2, 100, 100), [0, 1]);
});

const P: Policy = { keepAllHours: 1, keepHourlyDays: 1, keepDailyDays: 10, maxAgeDays: 0 };

async function fill(h: History, path: string, times: number[]) {
  for (const t of times) await h.record(path, "v" + t, t);
}

test("prune: keep-all tier", async () => {
  const { h } = mk();
  const now = 100 * D;
  await fill(h, "a", [now - 10, now - 20, now - 30 * 60000]);
  const r = await h.prune(P, now);
  assert.equal(r.removedVersions, 0);
});

test("prune: hourly tier", async () => {
  const { h } = mk();
  const now = 100 * D;
  const base = now - 5 * H; // aligned to hour
  await fill(h, "a", [base + 1, base + 2, base + H + 1, base + H + 2]);
  const r = await h.prune(P, now);
  assert.equal(r.removedVersions, 2);
  assert.deepEqual(h.versionsOf("a").map((v) => v.time), [base + H + 2, base + 2]);
});

test("prune: daily tier", async () => {
  const { h } = mk();
  const now = 100 * D;
  const day = now - 5 * D; // day aligned
  await fill(h, "a", [day + 1 * H, day + 2 * H, day + D + H]);
  const r = await h.prune(P, now);
  assert.equal(r.removedVersions, 1);
  assert.deepEqual(h.versionsOf("a").map((v) => v.time), [day + D + H, day + 2 * H]);
});

test("prune: weekly tier and maxAge", async () => {
  const { h } = mk();
  const now = 400 * D;
  const old = 100 * D;
  // Days 100..106 span at most two ISO weeks; collect expectation by week index.
  const times = [0, 1, 2, 3, 4, 5, 6].map((i) => old + i * D + H);
  await fill(h, "a", times);
  const weeks = new Set(times.map((t) => Math.floor((Math.floor(t / D) + 3) / 7)));
  const r = await h.prune(P, now);
  assert.equal(h.versionsOf("a").length, weeks.size);
  assert.equal(r.removedVersions, 7 - weeks.size);

  const { h: h2 } = mk();
  await fill(h2, "a", times);
  await h2.record("a", "recent", now - H / 2);
  await h2.record("b", "x", old);
  await h2.record("b", null, old + 1);
  await h2.record("c", "x", old);
  const r2 = await h2.prune({ ...P, maxAgeDays: 200 }, now);
  // a: 7 old dropped (age 300d > 200d), recent kept. b: tombstone only remains -> path gone. c: newest kept.
  assert.equal(h2.versionsOf("a").length, 1);
  assert.equal(h2.versionsOf("b").length, 0);
  assert.equal(h2.versionsOf("c").length, 1);
  assert.equal(r2.removedVersions, 7 + 2);
});

test("prune keeps newest per path and tombstone newest", async () => {
  const { h } = mk();
  const now = 1000 * D;
  await h.record("a", "x", 1 * D);
  await h.record("b", "y", 2 * D);
  await h.record("b", null, 3 * D);
  await h.prune(P, now); // maxAge 0: nothing dropped beyond thinning
  assert.equal(h.versionsOf("a").length, 1);
  assert.equal(h.versionsOf("b")[0]!.hash, null);
  await h.prune({ ...P, maxAgeDays: 1 }, now);
  assert.equal(h.versionsOf("a").length, 1); // live note keeps its newest
  assert.equal(h.versionsOf("b").length, 0);
});

test("blob GC removes only unreferenced blobs; prune idempotent", async () => {
  const { s, h } = mk();
  const now = 100 * D;
  const base = now - 5 * H;
  await fill(h, "a", [base + 1, base + 2]);
  await h.record("b", "live", now);
  s.texts.set("orphan", "zzz");
  const r = await h.prune(P, now);
  assert.equal(r.removedVersions, 1);
  assert.equal(r.removedBlobs, 2); // v(base+1) and orphan
  assert.deepEqual([...s.texts.keys()].sort(), [...new Set(h.all.map((v) => v.hash!))].sort());
  const snap = JSON.stringify(s.json.get("log"));
  const r2 = await h.prune(P, now);
  assert.deepEqual(r2, { removedVersions: 0, removedBlobs: 0 });
  assert.equal(JSON.stringify(s.json.get("log")), snap);
  // persisted
  const h2 = new History(s, fnv);
  await h2.load();
  assert.equal(h2.totals().versions, 2);
});

test("shared blob survives when another version still references it", async () => {
  const { s, h } = mk();
  const now = 100 * D;
  const base = now - 5 * H;
  await h.record("a", "same", base + 1);
  await h.record("a", "other", base + 2);
  await h.record("b", "same", now);
  await h.prune(P, now);
  assert.ok([...s.texts.values()].includes("same"));
});

test("concurrency: 50 interleaved records", async () => {
  const s = new MemoryStorage();
  let writes = 0;
  const orig = s.writeText.bind(s);
  s.writeText = async (k, t) => {
    writes++;
    await new Promise((r) => setTimeout(r, 1));
    return orig(k, t);
  };
  const slowHash = async (t: string) => {
    await new Promise((r) => setTimeout(r, Math.random() * 3));
    return fnv(t);
  };
  const h = new History(s, slowHash);
  const jobs: Promise<boolean>[] = [];
  for (let i = 0; i < 50; i++) jobs.push(h.record("p" + (i % 5), "content " + (i % 10), i));
  const res = await Promise.all(jobs);
  assert.equal(res.filter(Boolean).length, 50 - res.filter((x) => !x).length);
  // p_k gets contents k, k+5 alternating -> all distinct from previous => all 10 recorded each
  assert.equal(h.totals().versions, 50);
  assert.equal(s.texts.size, 10);
  assert.equal(writes, 10);
  const same = new History(new MemoryStorage(), fnv);
  const r2 = await Promise.all(Array.from({ length: 50 }, (_, i) => same.record("x", "same", i)));
  assert.equal(r2.filter(Boolean).length, 1);
});
