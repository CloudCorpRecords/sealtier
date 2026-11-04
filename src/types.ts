/**
 * sealtier types.
 *
 * Shared shapes for the three tools: scan results (corpus tier, per-file
 * gaps, coverage, score, Merkle root), trust verdicts, and git change
 * reports. All values are plain JSON-compatible data; frontmatter values
 * are strings, string arrays, nested plain objects, or null (the subset
 * the hand-rolled parser produces).
 */

export type TierName = "none" | "bronze" | "silver" | "gold";

export type FixMark = "AUTO" | "NEEDS-CLIENT";

/** One missing-field entry in a file's per-tier gap list. */
export interface MissingEntry {
  field: string;
  fix: FixMark;
  /** Proposed value — only on the missing-`type` proposal. */
  value?: string;
  /** Confidence of the proposal — only on the missing-`type` entry. */
  confidence?: string;
  /** Whether the value was inferred — only on the missing-`type` entry. */
  inferred?: boolean;
}

export interface FileScan {
  /** Base name of the file, e.g. "expenses.md". */
  name: string;
  tier: TierName;
  /** Populated tier fields, in tier order. */
  present: string[];
  /**
   * Gap lists keyed by tier. "silver" and "gold" are always present
   * (empty when that tier's own fields are all populated); "bronze" is
   * present only when `type` itself is missing.
   */
  missing: {
    bronze?: MissingEntry[];
    silver: MissingEntry[];
    gold: MissingEntry[];
  };
  /** False when a frontmatter block exists but does not parse. */
  frontmatter_ok: boolean;
  /** Hex sha256 of the file's raw contents. */
  sha256: string;
}

export interface SkippedEntry {
  name: string;
  reason: string;
}

export interface ScanResult {
  corpus: {
    file_count: number;
    /** Tier of the weakest file ("none" for an empty corpus). */
    tier: TierName;
    /** Share of files reaching each tier, one decimal place. */
    coverage: { bronze: number; silver: number; gold: number };
  };
  files: FileScan[];
  skipped: SkippedEntry[];
  certified_eligible: boolean;
  /** 0-100. Reconstruction: round(mean of the three coverage values). */
  score: number;
  /** Reconstruction: hex sha256 of the concatenated per-file sha256 hex digests, files ordered by name. */
  merkle_root: string;
  /** Reconstruction: "scan-" + first 12 hex chars of the Merkle root. */
  audit_id: string;
  /** The tier -> required-fields mapping (cumulative). */
  rubric: { bronze: string[]; silver: string[]; gold: string[] };
}

export type TrustVerdict = "stale" | "unverified" | "ok";

export interface TrustResult {
  /** Base name of the file. */
  name: string;
  verdict: TrustVerdict;
  reasons: string[];
  /** Bronze conformance: a populated `type` field. */
  okf_conformant: boolean;
  /** Reconstruction of OKF SS5.3: human-reviewed / generated / unverified. */
  trust_tier: string;
  /** The file's `status` field as written, or null. */
  status: string | null;
  stale: boolean;
  /** "2026-08-21" when a checked timestamp is a datetime with a UTC offset, else "pre-2026-08-21". */
  which_0_2: string;
  /** Trust timestamps exactly as written in the frontmatter (null when absent). */
  verified: unknown;
  generated: unknown;
  stale_after: unknown;
}

export interface TrustFolderResult {
  files: TrustResult[];
}

export interface FrontmatterChange {
  field: string;
  change: "added" | "removed" | "changed";
  /** Serialised old value (null when the field was absent). */
  from: string | null;
  /** Serialised new value (null when the field is absent). */
  to: string | null;
}

export interface FileChange {
  /** Base name of the file. */
  name: string;
  /** Path relative to the folder root. */
  path: string;
  /** True when the file does not exist at the compared ref. */
  is_new: boolean;
  /** True when the file exists at the ref but not in the working tree. */
  deleted: boolean;
  frontmatter_changes: FrontmatterChange[];
  body_changed: boolean;
  trust_effects: string[];
}

export interface ChangesResult {
  path: string;
  ref: string;
  files: FileChange[];
}

/** Result of one git invocation through the injectable executor. */
export interface GitExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Runs git with the given argv (the core builds the full argument list,
 * including `-c protocol.allow=never` and `-C <folder>`). Tests inject a
 * fake executor; no real git runs in tests.
 */
export type GitExecutor = (args: string[]) => GitExecResult;

/** Injectable dependencies for the core: a fixed clock and a git executor. */
export interface CoreOptions {
  /** Clock for "in the past" comparisons (trust). Defaults to the real clock. */
  now?: Date;
  /** Git executor (changes). Defaults to the local git program. */
  executor?: GitExecutor;
}
