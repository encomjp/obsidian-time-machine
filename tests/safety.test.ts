import { test } from "node:test";
import assert from "node:assert/strict";
import { History, MemoryStorage } from "../src/history.ts";
import type { Policy } from "../src/types.ts";

const fnv = async (t: string): Promise<string> => {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0") + ":" + t.length;
};
const D = 86400000;

test("a lost log next to stored texts never lets prune delete them", async () => {
  const s = new MemoryStorage();
  const a = new History(s, fnv);
  await a.load();
  await a.record("n.md", "precious", 1000);
  await a.flush();
  s.json.delete("log"); // the log vanishes (crash between remove and rename)
  const b = new History(s, fnv);
  await b.load();
  assert.equal(b.unsafe, true);
  const r = await b.prune({ keepAllHours: 1, keepHourlyDays: 1, keepDailyDays: 1, maxAgeDays: 1 }, 1000 + 400 * D);
  assert.equal(r.removedBlobs, 0);
  assert.equal(s.texts.size, 1);
});

test("a healthy empty vault is not treated as unsafe", async () => {
  const h = new History(new MemoryStorage(), fnv);
  await h.load();
  assert.equal(h.unsafe, false);
});

test("a damaged stored text is never returned", async () => {
  const s = new MemoryStorage();
  const h = new History(s, fnv);
  await h.record("n.md", "whole text", 1);
  const v = h.latest("n.md")!;
  assert.equal(await h.text(v), "whole text");
  s.texts.set(v.hash!, "whole te"); // truncated
  assert.equal(await h.text(v), null);
});

test("maxAgeDays drops old versions even inside the daily tier", async () => {
  const h = new History(new MemoryStorage(), fnv);
  const now = 100 * D;
  await h.record("n.md", "old", now - 30 * D);
  await h.record("n.md", "new", now - 1 * D);
  const policy: Policy = { keepAllHours: 24, keepHourlyDays: 7, keepDailyDays: 90, maxAgeDays: 10 };
  const r = await h.prune(policy, now);
  assert.equal(r.removedVersions, 1);
  assert.deepEqual(h.versionsOf("n.md").map((v) => v.time), [now - D]);
});

test("prune saves the log before it removes texts", async () => {
  const s = new MemoryStorage();
  const h = new History(s, fnv);
  await h.record("n.md", "a", 1);
  await h.record("n.md", "b", 2 * D);
  const order: string[] = [];
  const wj = s.writeJson.bind(s), rt = s.removeText.bind(s);
  s.writeJson = async (n, v) => { order.push("log"); return wj(n, v); };
  s.removeText = async (k) => { order.push("blob"); return rt(k); };
  await h.prune({ keepAllHours: 0, keepHourlyDays: 0, keepDailyDays: 0, maxAgeDays: 1 }, 10 * D);
  assert.ok(order.length >= 2);
  assert.equal(order[0], "log");
});
