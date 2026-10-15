import { MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, type WorkspaceLeaf } from "obsidian";
import { History } from "./history.ts";
import { sha256, VaultStorage } from "./storage.ts";
import { DEFAULT_POLICY, type Policy, type Version } from "./types.ts";
import { TimeMachineView, VIEW_TYPE } from "./view.ts";

interface Settings {
  /** Seconds a note must stay unchanged before its new state is saved. */
  settleSeconds: number;
  /** Notes in these folders are not tracked. One per line. */
  excludeFolders: string;
  /** Notes larger than this are not tracked. */
  maxFileKB: number;
  policy: Policy;
}

const DEFAULT_SETTINGS: Settings = { settleSeconds: 20, excludeFolders: "", maxFileKB: 2048, policy: { ...DEFAULT_POLICY } };

export default class TimeMachinePlugin extends Plugin {
  override settings: Settings = { ...DEFAULT_SETTINGS, policy: { ...DEFAULT_POLICY } };
  history!: History;
  private readonly timers = new Map<string, number>();
  /** Latest text of notes with a pending save, so a quick delete or quit does not lose the last edit. */
  private readonly pendingText = new Map<string, string>();
  private statusEl: HTMLElement | null = null;
  /** Path the view should focus when it opens. */
  focusPath: string | null = null;

  override async onload() {
    const saved = (await this.loadData()) as Partial<Settings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...saved, policy: { ...DEFAULT_POLICY, ...saved?.policy } };

    const dir = `${this.app.vault.configDir}/plugins/${this.manifest.id}/history`;
    this.history = new History(new VaultStorage(this.app.vault.adapter, dir), sha256);
    await this.history.load();

    this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new TimeMachineView(leaf, this));
    this.addRibbonIcon("history", "Vault Time Machine", () => void this.openView());
    this.addCommand({ id: "open", name: "Open Time Machine", callback: () => void this.openView() });
    this.addCommand({
      id: "note-history",
      name: "Show history of this note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.tracked(file)) return false;
        if (!checking) void this.openView(file.path);
        return true;
      },
    });
    this.addCommand({ id: "snapshot", name: "Save a snapshot of every note now", callback: () => void this.snapshotAll(true) });
    this.addCommand({ id: "prune", name: "Thin out old history now", callback: () => void this.prune(true) });
    this.addSettingTab(new TimeMachineSettings(this.app, this));

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("mod-clickable");
    this.statusEl.addEventListener("click", () => void this.openView());
    this.updateStatus();

    this.app.workspace.onLayoutReady(() => {
      const vault = this.app.vault;
      this.registerEvent(vault.on("modify", (f) => { if (f instanceof TFile && this.tracked(f)) this.schedule(f); }));
      this.registerEvent(vault.on("create", (f) => { if (f instanceof TFile && this.tracked(f)) this.schedule(f); }));
      this.registerEvent(vault.on("delete", (f) => { if (f instanceof TFile && f.extension === "md") void this.recordDeletion(f.path); }));
      this.registerEvent(vault.on("rename", (f, old) => {
        if (!(f instanceof TFile)) return;
        if (old.toLowerCase().endsWith(".md")) void this.recordDeletion(old);
        if (f.extension === "md" && this.tracked(f)) this.schedule(f, 0);
      }));
      void this.snapshotAll(false);
    });
  }

  override onunload() {
    for (const t of this.timers.values()) window.clearTimeout(t);
    this.timers.clear();
    const pending = [...this.pendingText];
    this.pendingText.clear();
    void (async () => {
      for (const [path, text] of pending) await this.history.record(path, text, Date.now());
      await this.history.flush();
    })();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  tracked(file: TFile): boolean {
    if (file.extension !== "md" || file.stat.size > this.settings.maxFileKB * 1024) return false;
    const excluded = this.settings.excludeFolders.split("\n").map((s) => s.trim().replace(/^\/|\/$/g, "")).filter(Boolean);
    return !excluded.some((d) => file.path === d || file.path.startsWith(d + "/"));
  }

  private schedule(file: TFile, seconds = this.settings.settleSeconds) {
    const prev = this.timers.get(file.path);
    if (prev !== undefined) window.clearTimeout(prev);
    void this.app.vault.cachedRead(file).then((text) => { if (this.timers.has(file.path)) this.pendingText.set(file.path, text); }, () => undefined);
    this.timers.set(file.path, window.setTimeout(() => {
      this.timers.delete(file.path);
      void this.capture(file.path);
    }, seconds * 1000));
  }

  /** Saves the note's current content if it differs from its latest version. */
  async capture(path: string, time = Date.now()): Promise<boolean> {
    this.pendingText.delete(path);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || !this.tracked(file)) return false;
    const text = await this.app.vault.read(file);
    const changed = await this.history.record(path, text, time);
    if (changed) { this.updateStatus(); await this.persistSoon(); }
    return changed;
  }

  private async recordDeletion(path: string) {
    const pending = this.timers.get(path);
    if (pending !== undefined) { window.clearTimeout(pending); this.timers.delete(path); }
    const last = this.pendingText.get(path);
    this.pendingText.delete(path);
    const now = Date.now();
    // An edit made just before the delete is kept as the last version before the tombstone.
    if (last !== undefined) await this.history.record(path, last, now - 1);
    if (await this.history.record(path, null, now)) { this.updateStatus(); await this.persistSoon(); }
  }

  private flushTimer: number | null = null;
  private persistSoon(): Promise<void> {
    if (this.flushTimer === null) {
      this.flushTimer = window.setTimeout(() => { this.flushTimer = null; void this.history.flush(); }, 5000);
    }
    return Promise.resolve();
  }

  /** Records the current state of notes that changed while the plugin was not running (or have no history yet). */
  async snapshotAll(manual: boolean) {
    let n = 0;
    const files = this.app.vault.getMarkdownFiles().filter((f) => this.tracked(f));
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      const has = this.history.latest(f.path);
      if (has && has.hash !== null && f.stat.mtime <= has.time) continue;
      const text = await this.app.vault.cachedRead(f);
      // A note with no history is recorded at its modification time, so the timeline starts where the note did.
      if (await this.history.record(f.path, text, has ? Date.now() : Math.min(f.stat.mtime, Date.now()))) n++;
      if (i % 25 === 24) await new Promise((r) => window.setTimeout(r, 0));
    }
    await this.history.flush();
    this.updateStatus();
    if (manual) new Notice(n ? `Saved ${n} note${n === 1 ? "" : "s"}` : "Nothing new to save");
    await this.prune(false);
  }

  async prune(manual: boolean) {
    const r = await this.history.prune(this.settings.policy, Date.now());
    this.updateStatus();
    if (manual) new Notice(`Removed ${r.removedVersions} old version${r.removedVersions === 1 ? "" : "s"}`);
  }

  /** Puts `version` back as the note's content, saving the current content first so the restore can be undone. */
  async restore(version: Version, asCopy = false): Promise<string | null> {
    const text = await this.history.text(version);
    if (text === null) { new Notice("That version is missing or damaged, so it was not restored."); return null; }
    const path = asCopy ? await this.freePath(version.path, version.time) : version.path;
    const target = this.app.vault.getAbstractFileByPath(path);
    if (target instanceof TFile) {
      // Flush anything still sitting in an open editor to disk, then back up exactly what is there.
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) await leaf.view.save();
      }
      const current = await this.app.vault.read(target);
      await this.history.record(path, current, Date.now());
      await this.history.flush();
      if (this.history.latest(path)?.hash !== (await sha256(current))) { new Notice("Could not back up the current text, so nothing was restored."); return null; }
      let conflict = false;
      await this.app.vault.process(target, (data) => {
        if (data !== current) { conflict = true; return data; }
        return text;
      });
      if (conflict) { new Notice("The note changed while restoring. Nothing was overwritten; try again."); return null; }
    } else {
      const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (folder && !(await this.app.vault.adapter.exists(folder))) await this.app.vault.createFolder(folder);
      await this.app.vault.create(path, text);
    }
    await this.history.record(path, text, Date.now() + 1);
    await this.history.flush();
    this.updateStatus();
    return path;
  }

  /** Restores several versions; returns how many notes were actually put back. */
  async restoreMany(versions: Version[]): Promise<number> {
    let n = 0;
    for (const v of versions) if (v.hash !== null && (await this.restore(v)) !== null) n++;
    await this.history.flush();
    return n;
  }

  private async freePath(path: string, time: number): Promise<string> {
    const stamp = new Date(time).toISOString().slice(0, 16).replace("T", " ").replace(":", ".");
    const base = path.replace(/\.md$/i, "");
    let candidate = `${base} (restored ${stamp}).md`;
    for (let i = 2; this.app.vault.getAbstractFileByPath(candidate); i++) candidate = `${base} (restored ${stamp} ${i}).md`;
    return candidate;
  }

  private updateStatus() {
    const t = this.history.totals();
    this.statusEl?.setText(`⏱ ${t.versions} versions`);
    this.statusEl?.setAttr("aria-label", `Vault Time Machine: ${t.versions} versions of ${t.paths} notes`);
  }

  async openView(path: string | null = null) {
    this.focusPath = path;
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getLeaf("tab");
    if (!existing) await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
    (leaf.view as TimeMachineView).focusNote(path);
  }
}

class TimeMachineSettings extends PluginSettingTab {
  private readonly plugin: TimeMachinePlugin;

  constructor(app: TimeMachinePlugin["app"], plugin: TimeMachinePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  override display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const num = (name: string, desc: string, get: () => number, set: (n: number) => void, min = 0) =>
      new Setting(containerEl).setName(name).setDesc(desc).addText((t) => t.setValue(String(get())).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= min) { set(n); await this.plugin.saveSettings(); }
      }));

    num("Save after quiet for (seconds)", "A note's new state is saved once you stop editing it for this long.", () => s.settleSeconds, (n) => (s.settleSeconds = n), 1);
    num("Skip notes larger than (KB)", "Very large notes are not tracked.", () => s.maxFileKB, (n) => (s.maxFileKB = n), 1);
    new Setting(containerEl).setName("Excluded folders").setDesc("One folder per line. Notes inside are not tracked.")
      .addTextArea((t) => t.setValue(s.excludeFolders).onChange(async (v) => { s.excludeFolders = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("Keeping history").setHeading();
    num("Keep every version for (hours)", "Newer than this, nothing is thinned out.", () => s.policy.keepAllHours, (n) => (s.policy.keepAllHours = n));
    num("Then hourly for (days)", "One version per note per hour.", () => s.policy.keepHourlyDays, (n) => (s.policy.keepHourlyDays = n));
    num("Then daily for (days)", "One version per note per day; older than this, one per week.", () => s.policy.keepDailyDays, (n) => (s.policy.keepDailyDays = n));
    num("Delete history older than (days)", "0 keeps it forever. The newest version of every note is always kept.", () => s.policy.maxAgeDays, (n) => (s.policy.maxAgeDays = n));
    new Setting(containerEl).setName("Thin out now").addButton((b) => b.setButtonText("Run").onClick(() => void this.plugin.prune(true)));
  }
}
