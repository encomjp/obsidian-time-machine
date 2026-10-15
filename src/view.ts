import { ItemView, Modal, Notice, TFile, type App, type WorkspaceLeaf } from "obsidian";
import { diffLines, diffWords, stats, toHunks } from "./diff.ts";
import type TimeMachinePlugin from "./main.ts";
import type { Change, DiffLine, Piece, Version } from "./types.ts";

export const VIEW_TYPE = "vault-time-machine";
const STRIP_CELLS = 72;
const SLIDER_STEPS = 1000;

function stamp(t: number): string {
  return new Date(t).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export class TimeMachineView extends ItemView {
  private readonly plugin: TimeMachinePlugin;
  private time = 0;
  private filter = "";
  private selected: string | null = null;
  private stripEl!: HTMLElement;
  private sliderEl!: HTMLInputElement;
  private labelEl!: HTMLElement;
  private listEl!: HTMLElement;
  private diffEl!: HTMLElement;
  private filterEl!: HTMLInputElement;
  private times: number[] = [];
  private renderToken = 0;

  constructor(leaf: WorkspaceLeaf, plugin: TimeMachinePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Time Machine"; }
  override getIcon() { return "history"; }

  override async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("tm-root");

    const top = root.createDiv({ cls: "tm-top" });
    this.labelEl = top.createDiv({ cls: "tm-label" });
    const nav = top.createDiv({ cls: "tm-nav" });
    const prev = nav.createEl("button", { text: "◀", attr: { "aria-label": "Previous change" } });
    const next = nav.createEl("button", { text: "▶", attr: { "aria-label": "Next change" } });
    const now = nav.createEl("button", { text: "Now" });
    const refresh = nav.createEl("button", { text: "⟳", attr: { "aria-label": "Refresh" } });
    prev.addEventListener("click", () => this.jump(-1));
    next.addEventListener("click", () => this.jump(1));
    now.addEventListener("click", () => this.setTime(Date.now()));
    refresh.addEventListener("click", () => this.reload());

    const track = root.createDiv({ cls: "tm-track" });
    this.stripEl = track.createDiv({ cls: "tm-strip" });
    this.sliderEl = track.createEl("input", { type: "range", cls: "tm-slider" });
    this.sliderEl.min = "0";
    this.sliderEl.max = String(SLIDER_STEPS);
    this.sliderEl.addEventListener("input", () => {
      const r = this.plugin.history.range();
      if (!r) return;
      this.time = r.first + ((r.last - r.first) * Number(this.sliderEl.value)) / SLIDER_STEPS;
      this.renderMoment();
    });

    const body = root.createDiv({ cls: "tm-body" });
    const side = body.createDiv({ cls: "tm-side" });
    this.filterEl = side.createEl("input", { type: "search", placeholder: "Filter notes…", cls: "tm-filter" });
    this.filterEl.addEventListener("input", () => { this.filter = this.filterEl.value; this.renderList(); });
    this.listEl = side.createDiv({ cls: "tm-list" });
    this.diffEl = body.createDiv({ cls: "tm-diff" });
    this.reload();
  }

  /** Called when opened from "Show history of this note". */
  focusNote(path: string | null) {
    if (!this.listEl) return;
    this.filter = path ?? "";
    this.filterEl.value = this.filter;
    this.selected = path;
    const v = path ? this.plugin.history.versionsOf(path) : [];
    // Start just before the latest edit so the first thing you see is what the last edit changed.
    if (v.length > 1) this.time = v[1]!.time;
    else if (v.length === 1) this.time = v[0]!.time - 1;
    this.reload(false);
  }

  private reload(resetTime = true) {
    const h = this.plugin.history;
    this.times = [...new Set(h.paths().flatMap((p) => h.versionsOf(p).map((v) => v.time)))].sort((a, b) => a - b);
    const r = h.range();
    if (r && (resetTime || this.time === 0)) this.time = r.last;
    this.renderStrip();
    this.renderMoment();
  }

  private setTime(t: number) {
    this.time = t;
    this.renderMoment();
  }

  private jump(dir: -1 | 1) {
    const eps = 1;
    const t = dir < 0 ? [...this.times].reverse().find((x) => x < this.time - eps) : this.times.find((x) => x > this.time + eps);
    if (t !== undefined) this.setTime(dir < 0 ? t - 1 : t);
    else if (dir > 0) this.setTime(Date.now());
  }

  private renderStrip() {
    this.stripEl.empty();
    const r = this.plugin.history.range();
    if (!r || r.last === r.first) return;
    const counts = this.plugin.history.activity(STRIP_CELLS, r.first, r.last);
    const max = Math.max(1, ...counts);
    for (const c of counts) {
      const cell = this.stripEl.createDiv({ cls: "tm-cell" });
      cell.setCssProps({ opacity: c === 0 ? "0.08" : String(0.25 + (0.75 * c) / max) });
    }
  }

  private renderMoment() {
    const r = this.plugin.history.range();
    if (!r) {
      this.labelEl.setText("No history yet. Edit a note, or run “Save a snapshot of every note now”.");
      this.listEl.empty();
      this.diffEl.empty();
      return;
    }
    const t = Math.min(Math.max(this.time, r.first), Math.max(r.last, Date.now()));
    this.time = t;
    const span = Math.max(1, r.last - r.first);
    this.sliderEl.value = String(Math.round(Math.min(1, Math.max(0, (t - r.first) / span)) * SLIDER_STEPS));
    this.labelEl.setText(`Vault as of ${stamp(t)}`);
    this.renderList();
  }

  private currentChanges(): Change[] {
    return this.plugin.history.changedBetween(this.time, Date.now() + 1)
      .filter((c) => this.filter === "" || c.path.toLowerCase().includes(this.filter.toLowerCase()));
  }

  private renderList() {
    const changes = this.currentChanges();
    this.listEl.empty();
    if (changes.length === 0) {
      this.listEl.createDiv({ cls: "tm-empty", text: "Nothing differs from now." });
      this.diffEl.empty();
      return;
    }
    if (!changes.some((c) => c.path === this.selected)) this.selected = changes[0]!.path;
    const head = this.listEl.createDiv({ cls: "tm-count-row" });
    head.createDiv({ cls: "tm-count", text: `${changes.length} note${changes.length === 1 ? "" : "s"} changed since` });
    const revertable = changes.filter((c) => c.before !== null);
    if (revertable.length > 0) {
      const all = head.createEl("button", { cls: "tm-all", text: `Restore ${revertable.length}…` });
      all.addEventListener("click", () => {
        const when = stamp(this.time);
        new ConfirmModal(this.app, `Restore ${revertable.length} note${revertable.length === 1 ? "" : "s"} to ${when}?`,
          "Each note is saved first, so this can be undone. Notes created after that moment are left alone.", async () => {
            const n = await this.plugin.restoreMany(revertable.map((c) => c.before!));
            new Notice(`Restored ${n} note${n === 1 ? "" : "s"} to ${when}`);
            this.reload(false);
          }).open();
      });
    }
    for (const c of changes) {
      const state = c.before === null ? "new" : c.after === null ? "deleted" : "edited";
      const row = this.listEl.createDiv({ cls: "tm-item" + (c.path === this.selected ? " is-active" : "") });
      row.createSpan({ cls: `tm-badge is-${state}`, text: state === "new" ? "A" : state === "deleted" ? "D" : "M" });
      const name = c.path.replace(/\.md$/i, "");
      row.createSpan({ cls: "tm-name", text: name.split("/").pop(), attr: { title: c.path } });
      if (name.includes("/")) row.createSpan({ cls: "tm-dir", text: name.slice(0, name.lastIndexOf("/")) });
      row.addEventListener("click", () => { this.selected = c.path; this.renderList(); });
    }
    const sel = changes.find((c) => c.path === this.selected)!;
    void this.renderDiff(sel);
  }

  private async renderDiff(change: Change) {
    const token = ++this.renderToken;
    const history = this.plugin.history;
    const old = change.after === null && change.before === null ? null : await this.textAt(change.path);
    const file = this.app.vault.getAbstractFileByPath(change.path);
    const current = file instanceof TFile ? await this.app.vault.cachedRead(file) : null;
    if (token !== this.renderToken) return;
    void history;

    this.diffEl.empty();
    const bar = this.diffEl.createDiv({ cls: "tm-bar" });
    bar.createDiv({ cls: "tm-path", text: change.path });
    const lines = diffLines(old ?? "", current ?? "");
    const { added, removed } = stats(lines);
    const stat = bar.createDiv({ cls: "tm-stat" });
    stat.createSpan({ cls: "tm-plus", text: `+${added}` });
    stat.createSpan({ cls: "tm-minus", text: ` −${removed}` });

    const actions = this.diffEl.createDiv({ cls: "tm-actions" });
    const version = this.versionAt(change.path);
    if (old === null) {
      actions.createDiv({ cls: "tm-hint", text: "Did not exist then. Showing what was added since." });
    } else if (version) {
      const label = current === null ? "Restore deleted note" : "Restore this version";
      const restore = actions.createEl("button", { cls: "mod-cta", text: label });
      restore.addEventListener("click", async () => {
        const path = await this.plugin.restore(version);
        if (path) { new Notice(`Restored ${path} to ${stamp(version.time)}`); this.reload(false); }
      });
      if (current !== null) {
        const copy = actions.createEl("button", { text: "Restore as a copy" });
        copy.addEventListener("click", async () => {
          const path = await this.plugin.restore(version, true);
          if (path) { new Notice(`Saved as ${path}`); this.reload(false); }
        });
      }
      const open = actions.createEl("button", { text: "Open note" });
      open.disabled = current === null;
      open.addEventListener("click", () => { if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file); });
    }
    actions.createDiv({ cls: "tm-hint", text: "Red = in the old version, green = now." });

    const view = this.diffEl.createDiv({ cls: "tm-lines" });
    if (added === 0 && removed === 0) { view.createDiv({ cls: "tm-empty", text: "Identical to the current text." }); return; }
    for (const hunk of toHunks(lines, 3)) {
      view.createDiv({ cls: "tm-hunk", text: `@@ line ${hunk.oldStart} → ${hunk.newStart}` });
      this.renderHunk(view, hunk.lines);
    }
  }

  private renderHunk(parent: HTMLElement, lines: DiffLine[]) {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      const next = lines[i + 1];
      // A deleted line directly followed by an added one is a rewrite: highlight just the changed words.
      if (l.kind === "del" && next?.kind === "add" && lines[i + 2]?.kind !== "add" && lines[i - 1]?.kind !== "del") {
        const w = diffWords(l.text, next.text);
        this.row(parent, l, w.old);
        this.row(parent, next, w.new);
        i++;
        continue;
      }
      this.row(parent, l);
    }
  }

  private row(parent: HTMLElement, l: DiffLine, pieces?: Piece[]) {
    const row = parent.createDiv({ cls: `tm-line is-${l.kind}` });
    row.createSpan({ cls: "tm-no", text: String(l.oldNo ?? "") });
    row.createSpan({ cls: "tm-no", text: String(l.newNo ?? "") });
    row.createSpan({ cls: "tm-sign", text: l.kind === "add" ? "+" : l.kind === "del" ? "−" : " " });
    const text = row.createSpan({ cls: "tm-text" });
    if (!pieces) { text.setText(l.text); return; }
    for (const p of pieces) text.createSpan({ cls: p.kind === "equal" ? "" : "tm-mark", text: p.text });
  }

  private versionAt(path: string): Version | null {
    return this.plugin.history.stateAt(this.time).get(path) ?? null;
  }

  private async textAt(path: string): Promise<string | null> {
    const v = this.versionAt(path);
    return v ? this.plugin.history.text(v) : null;
  }
}

class ConfirmModal extends Modal {
  private readonly heading: string;
  private readonly body: string;
  private readonly onYes: () => Promise<void>;

  constructor(app: App, heading: string, body: string, onYes: () => Promise<void>) {
    super(app);
    this.heading = heading;
    this.body = body;
    this.onYes = onYes;
  }

  override onOpen() {
    this.titleEl.setText(this.heading);
    this.contentEl.createEl("p", { text: this.body });
    const bar = this.contentEl.createDiv({ cls: "modal-button-container" });
    bar.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    const yes = bar.createEl("button", { cls: "mod-cta", text: "Restore" });
    yes.addEventListener("click", () => { this.close(); void this.onYes(); });
  }
}
