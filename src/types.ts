// Shared contract for the history engine. Pure TypeScript: no Obsidian imports, so it is unit-testable in Node.

/** One saved state of one note. `hash === null` means the note was deleted at `time`. */
export interface Version {
  path: string;
  /** Content hash (key of the stored text), or null for a deletion. */
  hash: string | null;
  /** Milliseconds since epoch. */
  time: number;
  /** Length of the text in characters (0 for deletions). */
  size: number;
}

/** Where history lives. In the plugin this is a folder inside the vault's config dir; in tests, memory. */
export interface Storage {
  readJson(name: string): Promise<unknown>;
  writeJson(name: string, value: unknown): Promise<void>;
  readText(key: string): Promise<string | null>;
  writeText(key: string, text: string): Promise<void>;
  removeText(key: string): Promise<void>;
  listTexts(): Promise<string[]>;
}

export type Hasher = (text: string) => Promise<string>;

export interface Change {
  path: string;
  /** State at the earlier moment (null: did not exist). */
  before: Version | null;
  /** State at the later moment (null: did not exist / deleted). */
  after: Version | null;
}

/** Retention. Anything newer than `keepAllHours` is kept; older versions thin out to one per hour, then one per day. */
export interface Policy {
  keepAllHours: number;
  keepHourlyDays: number;
  keepDailyDays: number;
  /** Versions older than this many days are dropped, except the newest version of each live note. 0 = never drop. */
  maxAgeDays: number;
}

export const DEFAULT_POLICY: Policy = { keepAllHours: 24, keepHourlyDays: 7, keepDailyDays: 90, maxAgeDays: 0 };

// ---- diff ----

export type DiffKind = "equal" | "add" | "del";

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-based line number in the old text (undefined for added lines). */
  oldNo?: number;
  /** 1-based line number in the new text (undefined for deleted lines). */
  newNo?: number;
}

/** A run of changed lines with surrounding context. */
export interface Hunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

/** Word-level pieces of a changed line pair, so the UI can highlight just what changed. */
export interface Piece {
  kind: DiffKind;
  text: string;
}
