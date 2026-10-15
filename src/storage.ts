import type { DataAdapter } from "obsidian";
import type { Hasher, Storage } from "./types.ts";

/** History on disk, inside the plugin's own folder: log.json plus one text file per distinct content. */
export class VaultStorage implements Storage {
  private readonly adapter: DataAdapter;
  private readonly dir: string;
  private ready: Promise<void> | null = null;

  constructor(adapter: DataAdapter, dir: string) {
    this.adapter = adapter;
    this.dir = dir;
  }

  private blobs() { return `${this.dir}/blobs`; }

  private init(): Promise<void> {
    this.ready ??= (async () => {
      for (const d of [this.dir, this.blobs()]) if (!(await this.adapter.exists(d))) await this.adapter.mkdir(d);
    })().catch((e) => { this.ready = null; throw e; });
    return this.ready;
  }

  async readJson(name: string): Promise<unknown | null> {
    await this.init();
    const base = `${this.dir}/${name}.json`;
    // The file itself, then the newest copy a crashed write may have left behind.
    for (const path of [base, base + ".tmp", base + ".bak"]) {
      try {
        if (!(await this.adapter.exists(path))) continue;
        return JSON.parse(await this.adapter.read(path));
      } catch {
        // try the next copy
      }
    }
    return null;
  }

  async writeJson(name: string, value: unknown): Promise<void> {
    await this.init();
    const path = `${this.dir}/${name}.json`;
    const tmp = path + ".tmp";
    const bak = path + ".bak";
    await this.adapter.write(tmp, JSON.stringify(value));
    // The previous log is kept as .bak until the new one is in place, so no crash leaves zero copies.
    if (await this.adapter.exists(path)) {
      if (await this.adapter.exists(bak)) await this.adapter.remove(bak);
      await this.adapter.rename(path, bak);
    }
    await this.adapter.rename(tmp, path);
  }

  async readText(key: string): Promise<string | null> {
    await this.init();
    const path = `${this.blobs()}/${key}.txt`;
    try {
      return (await this.adapter.exists(path)) ? await this.adapter.read(path) : null;
    } catch {
      return null;
    }
  }

  async writeText(key: string, text: string): Promise<void> {
    await this.init();
    const path = `${this.blobs()}/${key}.txt`;
    if (await this.adapter.exists(path)) return;
    const tmp = path + ".tmp";
    await this.adapter.write(tmp, text);
    await this.adapter.rename(tmp, path);
  }

  async removeText(key: string): Promise<void> {
    await this.init();
    const path = `${this.blobs()}/${key}.txt`;
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }

  async listTexts(): Promise<string[]> {
    await this.init();
    const { files } = await this.adapter.list(this.blobs());
    return files.map((f) => f.slice(f.lastIndexOf("/") + 1)).filter((n) => n.endsWith(".txt")).map((n) => n.slice(0, -4));
  }
}

/** SHA-256 hex of the text. */
export const sha256: Hasher = async (text) => {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
};
