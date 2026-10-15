import type { Change, Hasher, Policy, Storage, Version } from "./types.ts";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** In-memory Storage, for tests. */
export class MemoryStorage implements Storage {
  json: Map<string, unknown>;
  texts: Map<string, string>;

  constructor() {
    this.json = new Map();
    this.texts = new Map();
  }
  async readJson(name: string): Promise<unknown> {
    return this.json.has(name) ? structuredClone(this.json.get(name)) : null;
  }
  async writeJson(name: string, value: unknown): Promise<void> {
    this.json.set(name, structuredClone(value));
  }
  async readText(key: string): Promise<string | null> {
    return this.texts.has(key) ? (this.texts.get(key) as string) : null;
  }
  async writeText(key: string, text: string): Promise<void> {
    this.texts.set(key, text);
  }
  async removeText(key: string): Promise<void> {
    this.texts.delete(key);
  }
  async listTexts(): Promise<string[]> {
    return [...this.texts.keys()];
  }
}

function parseVersion(raw: unknown): Version | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.path !== "string") return null;
  if (typeof r.time !== "number" || !Number.isFinite(r.time)) return null;
  if (r.hash !== null && typeof r.hash !== "string") return null;
  if (r.hash === undefined) return null;
  let size = 0;
  if (r.hash !== null) {
    if (typeof r.size !== "number" || !Number.isFinite(r.size) || r.size < 0) return null;
    size = r.size;
  }
  return { path: r.path, hash: r.hash, time: r.time, size };
}

export class History {
  storage: Storage;
  hash: Hasher;
  /** All versions, ascending by time (stable for equal times). */
  all: Version[];
  /** Per path, ascending by time. */
  byPath: Map<string, Version[]>;
  /** Hashes known to be present in storage. */
  blobs: Set<string>;
  dirty: boolean;
  queue: Promise<unknown>;
  /** True when the saved log could not be trusted on load; blob cleanup is then refused so nothing is lost. */
  unsafe = false;

  constructor(storage: Storage, hash: Hasher) {
    this.storage = storage;
    this.hash = hash;
    this.all = [];
    this.byPath = new Map();
    this.blobs = new Set();
    this.dirty = false;
    this.queue = Promise.resolve();
  }

  /** Serialise mutating operations. */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async load(): Promise<void> {
    return this.enqueue(async () => {
      let raw: unknown = null;
      try {
        raw = await this.storage.readJson("log");
      } catch {
        raw = null;
      }
      const list: Version[] = [];
      if (Array.isArray(raw)) {
        for (const item of raw) {
          const v = parseVersion(item);
          if (v) list.push(v);
        }
      }
      this.all = [];
      this.byPath = new Map();
      list.forEach((v) => this.insert(v));
      this.dirty = false;
      this.blobs = new Set();
      let listed = false;
      try {
        for (const k of await this.storage.listTexts()) this.blobs.add(k);
        listed = true;
      } catch {
        // ignore
      }
      // An empty or unreadable log next to stored texts means the log was lost, not that there is no history.
      this.unsafe = !listed || (this.all.length === 0 && this.blobs.size > 0) || (raw !== null && !Array.isArray(raw));
    });
  }

  insert(v: Version): void {
    insertSorted(this.all, v);
    let arr = this.byPath.get(v.path);
    if (!arr) {
      arr = [];
      this.byPath.set(v.path, arr);
    }
    insertSorted(arr, v);
  }

  record(path: string, text: string | null, time: number): Promise<boolean> {
    return this.enqueue(async () => {
      const arr = this.byPath.get(path);
      const latest = arr && arr.length ? arr[arr.length - 1] : undefined;
      if (text === null) {
        if (!latest || latest.hash === null) return false;
        this.insert({ path, hash: null, time, size: 0 });
        this.dirty = true;
        return true;
      }
      const h = await this.hash(text);
      if (latest && latest.hash === h) return false;
      if (!this.blobs.has(h)) {
        await this.storage.writeText(h, text);
        this.blobs.add(h);
      }
      this.insert({ path, hash: h, time, size: text.length });
      this.dirty = true;
      return true;
    });
  }

  async flush(): Promise<void> {
    return this.enqueue(() => this.flushNow());
  }

  async flushNow(): Promise<void> {
    if (!this.dirty) return;
    await this.storage.writeJson("log", this.all.map((v) => ({ ...v })));
    this.dirty = false;
  }

  versionsOf(path: string): Version[] {
    const arr = this.byPath.get(path);
    return arr ? [...arr].reverse() : [];
  }

  paths(): string[] {
    return [...this.byPath.keys()];
  }

  stateAt(time: number): Map<string, Version> {
    const out = new Map<string, Version>();
    for (const [path, arr] of this.byPath) {
      // last index with time <= `time`
      let lo = 0;
      let hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid]!.time <= time) lo = mid + 1;
        else hi = mid;
      }
      if (lo === 0) continue;
      const v = arr[lo - 1]!;
      if (v.hash !== null) out.set(path, v);
    }
    return out;
  }

  changedBetween(from: number, to: number): Change[] {
    const a = this.stateAt(from);
    const b = this.stateAt(to);
    const keys = new Set<string>([...a.keys(), ...b.keys()]);
    const out: Change[] = [];
    for (const path of keys) {
      const before = a.get(path) ?? null;
      const after = b.get(path) ?? null;
      if ((before ? before.hash : null) === (after ? after.hash : null)) continue;
      out.push({ path, before, after });
    }
    out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
    return out;
  }

  /** The newest version of a note, or null if it has none. */
  latest(path: string): Version | null {
    const arr = this.byPath.get(path);
    return arr && arr.length ? arr[arr.length - 1]! : null;
  }

  async text(v: Version): Promise<string | null> {
    if (v.hash === null) return null;
    const text = await this.storage.readText(v.hash);
    if (text === null) return null;
    // A truncated or damaged text must never be restored into a note.
    return (await this.hash(text)) === v.hash ? text : null;
  }

  range(): { first: number; last: number } | null {
    if (!this.all.length) return null;
    return { first: this.all[0]!.time, last: this.all[this.all.length - 1]!.time };
  }

  activity(buckets: number, from: number, to: number): number[] {
    const n = Math.floor(buckets);
    if (!(n > 0)) return [];
    const out = new Array<number>(n).fill(0);
    for (const v of this.all) {
      if (v.time < from || v.time > to) continue;
      let i: number;
      if (to <= from) i = n - 1;
      else i = Math.min(n - 1, Math.floor(((v.time - from) / (to - from)) * n));
      out[i]!++;
    }
    return out;
  }

  prune(policy: Policy, now: number): Promise<{ removedVersions: number; removedBlobs: number }> {
    return this.enqueue(async () => {
      const keep = new Set<Version>();
      const maxAge = policy.maxAgeDays > 0 ? policy.maxAgeDays * DAY : 0;
      let removedVersions = 0;
      const newAll: Version[] = [];
      const newBy = new Map<string, Version[]>();

      for (const [path, arr] of this.byPath) {
        const groups = new Map<string, Version>();
        const dropped = new Set<Version>();
        for (const v of arr) {
          const age = now - v.time;
          let key: string | null;
          if (maxAge > 0 && age > maxAge) {
            dropped.add(v);
            continue;
          } else if (age <= policy.keepAllHours * HOUR) key = null;
          else if (age <= policy.keepHourlyDays * DAY) key = "h" + Math.floor(v.time / HOUR);
          else if (age <= policy.keepDailyDays * DAY) key = "d" + Math.floor(v.time / DAY);
          else key = "w" + Math.floor((Math.floor(v.time / DAY) + 3) / 7);
          if (key === null) keep.add(v);
          else groups.set(key, v); // arr ascending: later overwrites => newest
        }
        for (const v of groups.values()) keep.add(v);
        const newest = arr[arr.length - 1]!;
        keep.add(newest);
        let kept = arr.filter((v) => keep.has(v));
        // A path whose only remaining version is an expired tombstone disappears.
        if (kept.length === 1 && kept[0]!.hash === null && maxAge > 0 && now - kept[0]!.time > maxAge) kept = [];
        removedVersions += arr.length - kept.length;
        if (kept.length) {
          newBy.set(path, kept);
          for (const v of kept) newAll.push(v);
        }
      }
      newAll.sort((a, b) => a.time - b.time);
      if (removedVersions > 0) {
        this.all = newAll;
        this.byPath = newBy;
        this.dirty = true;
      }

      // The log is saved first: a crash after this point leaves unreferenced texts, never a log pointing at deleted ones.
      await this.flushNow();
      let removedBlobs = 0;
      if (!this.unsafe) {
        const referenced = new Set<string>();
        for (const v of this.all) if (v.hash !== null) referenced.add(v.hash);
        for (const key of await this.storage.listTexts()) {
          if (!referenced.has(key)) {
            await this.storage.removeText(key);
            this.blobs.delete(key);
            removedBlobs++;
          }
        }
      }
      return { removedVersions, removedBlobs };
    });
  }

  totals(): { versions: number; paths: number; bytes: number } {
    const seen = new Map<string, number>();
    for (const v of this.all) if (v.hash !== null) seen.set(v.hash, v.size);
    let bytes = 0;
    for (const s of seen.values()) bytes += s;
    return { versions: this.all.length, paths: this.byPath.size, bytes };
  }
}

/** Insert after any elements with an equal time (keeps insertion order stable). */
function insertSorted(arr: Version[], v: Version): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]!.time <= v.time) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, v);
}
