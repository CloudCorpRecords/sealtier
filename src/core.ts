/**
 * sealtier core: local, read-only OKF v0.2 tier checking for Markdown
 * folders. Three operations, all pure local computation:
 *
 *   scan    — tier every *.md file under a folder from its YAML
 *             frontmatter (Bronze: type; Silver: + title, description,
 *             timestamp, owner; Gold: + status, review_policy,
 *             reviewed_at, next_review_at), report per-file gaps,
 *             corpus coverage/score, and a Merkle root of the corpus.
 *   trust   — stale / unverified / ok verdict for one file or a folder,
 *             from its trust and lifecycle fields.
 *   changes — what differs from a git ref, what changed in frontmatter
 *             and body, and what that did to the file's trust. Git runs
 *             through an injectable executor with transports disabled.
 *
 * The score formula, the Merkle construction, the audit id, the
 * certified_eligible rule, the trust_tier mapping, the Gold fix marks,
 * the skipped rule, and the changes executor mechanics are labelled
 * reconstructions of behaviour the original's README does not publish
 * formulas for — see BUILD-REPORT.md. This rebuild writes nothing
 * anywhere (the original also wrote .jidoseal/ records; recorded as a
 * deviation in BUILD-REPORT.md).
 *
 * Frontmatter parsing is a small hand-rolled YAML subset: flat
 * `key: value` pairs, quoted strings, inline lists/maps, and one level
 * of indented block maps/lists (enough for `generated: {at: ...}` and
 * `sources: [{last_modified: ...}]`). A block that falls outside the
 * subset counts as unparseable (frontmatter_ok: false).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ChangesResult,
  CoreOptions,
  FileChange,
  FileScan,
  FrontmatterChange,
  GitExecResult,
  GitExecutor,
  MissingEntry,
  ScanResult,
  SkippedEntry,
  TierName,
  TrustFolderResult,
  TrustResult,
} from "./types.js";

export const VERSION = "0.1.0";

/* ------------------------------------------------------------------ */
/* Tier rubric                                                         */
/* ------------------------------------------------------------------ */

export const BRONZE_FIELDS = ["type"] as const;
export const SILVER_FIELDS = ["title", "description", "timestamp", "owner"] as const;
export const GOLD_FIELDS = ["status", "review_policy", "reviewed_at", "next_review_at"] as const;

/** All nine tier fields, in tier order (the order `present` is reported in). */
export const TIER_FIELDS: string[] = [...BRONZE_FIELDS, ...SILVER_FIELDS, ...GOLD_FIELDS];

export const RUBRIC: ScanResult["rubric"] = {
  bronze: [...BRONZE_FIELDS],
  silver: [...BRONZE_FIELDS, ...SILVER_FIELDS],
  gold: [...BRONZE_FIELDS, ...SILVER_FIELDS, ...GOLD_FIELDS],
};

const TIER_RANK: Record<TierName, number> = { none: 0, bronze: 1, silver: 2, gold: 3 };

/** Fix marks pinned by the spec's worked examples. */
function fixFor(field: string): MissingEntry {
  if (field === "type") {
    return { field, fix: "AUTO", value: "note", confidence: "MEDIUM", inferred: true };
  }
  if (field === "title" || field === "description" || field === "timestamp") {
    return { field, fix: "AUTO" };
  }
  // owner (pinned) and the four Gold fields (labelled reconstruction:
  // governance facts only the owner can state) are NEEDS-CLIENT.
  return { field, fix: "NEEDS-CLIENT" };
}

/* ------------------------------------------------------------------ */
/* Argument validation (the core validates every call itself)          */
/* ------------------------------------------------------------------ */

function requireArgsObject(args: unknown, tool: string): Record<string, unknown> {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`${tool}: arguments must be an object`);
  }
  return args as Record<string, unknown>;
}

function requirePath(args: Record<string, unknown>, tool: string): string {
  const p = args.path;
  if (typeof p !== "string" || p.trim() === "") {
    throw new Error(`${tool}: "path" is required and must be a non-empty string`);
  }
  return p;
}

export function validateScanArgs(args: unknown): { path: string } {
  return { path: requirePath(requireArgsObject(args, "jidoseal_scan"), "jidoseal_scan") };
}

export function validateTrustArgs(args: unknown): { path: string } {
  return { path: requirePath(requireArgsObject(args, "jidoseal_trust"), "jidoseal_trust") };
}

export function validateChangesArgs(args: unknown): { path: string; ref: string } {
  const obj = requireArgsObject(args, "jidoseal_changes");
  const p = requirePath(obj, "jidoseal_changes");
  const ref = obj.ref;
  if (ref === undefined || ref === null) return { path: p, ref: "HEAD" };
  if (typeof ref !== "string" || ref.trim() === "") {
    throw new Error(`jidoseal_changes: "ref" must be a non-empty string when given`);
  }
  return { path: p, ref };
}

/* ------------------------------------------------------------------ */
/* Hand-rolled YAML-subset frontmatter parser                          */
/* ------------------------------------------------------------------ */

export class FrontmatterParseError extends Error {}

export interface ParsedMarkdown {
  hasFrontmatter: boolean;
  /** False when a frontmatter block exists but does not parse. */
  frontmatterOk: boolean;
  fields: Record<string, unknown>;
  body: string;
}

const KEY_LINE = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/;

function parseScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === "") return null;
  if (s.startsWith('"')) {
    if (s.length < 2 || !s.endsWith('"')) {
      throw new FrontmatterParseError(`unbalanced double-quoted string: ${raw}`);
    }
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (s.startsWith("'")) {
    if (s.length < 2 || !s.endsWith("'")) {
      throw new FrontmatterParseError(`unbalanced single-quoted string: ${raw}`);
    }
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith("[")) {
    if (!s.endsWith("]")) throw new FrontmatterParseError(`unbalanced inline list: ${raw}`);
    const inner = s.slice(1, -1).trim();
    if (inner === "") return [];
    return splitTopLevel(inner).map((part) => parseScalar(part));
  }
  if (s.startsWith("{")) {
    if (!s.endsWith("}")) throw new FrontmatterParseError(`unbalanced inline map: ${raw}`);
    const inner = s.slice(1, -1).trim();
    const out: Record<string, unknown> = {};
    if (inner === "") return out;
    for (const part of splitTopLevel(inner)) {
      const m = KEY_LINE.exec(part.trim());
      if (!m) throw new FrontmatterParseError(`bad inline map entry: ${part}`);
      out[m[1]] = m[2] === undefined ? null : parseScalar(m[2]);
    }
    return out;
  }
  if (s === "null" || s === "~") return null;
  // Plain scalar: a trailing " # comment" is not part of the value.
  const hashIdx = s.indexOf(" #");
  return (hashIdx >= 0 ? s.slice(0, hashIdx) : s).trim();
}

/** Split on commas that are not inside quotes, brackets, or braces. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "[" || c === "{") {
      depth++;
    } else if (c === "]" || c === "}") {
      depth--;
    } else if (c === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

function indentOf(line: string): number {
  const m = /^[ ]*/.exec(line);
  return m ? m[0].length : 0;
}

/**
 * Parse the indented block that follows a `key:` line with no inline
 * value: either a block map (`sub: value` lines), a block list
 * (`- item` lines, whose items may be maps), or nothing (→ null).
 * Returns the value and the number of lines consumed.
 */
function parseBlock(lines: string[], start: number, parentIndent: number): { value: unknown; next: number } {
  let i = start;
  const block: string[] = [];
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    if (indentOf(line) <= parentIndent) break;
    block.push(line);
    i++;
  }
  if (block.length === 0) return { value: null, next: i };

  const base = Math.min(...block.map(indentOf));
  const stripped = block.map((l) => l.slice(base));
  const first = stripped[0];

  if (first === "-" || first.startsWith("- ")) {
    const items: unknown[] = [];
    let currentMap: Record<string, unknown> | null = null;
    for (const line of stripped) {
      if (line === "-" || line.startsWith("- ")) {
        const rest = line === "-" ? "" : line.slice(2);
        currentMap = null;
        if (rest.trim() === "") {
          items.push(null);
          continue;
        }
        const m = KEY_LINE.exec(rest.trim());
        if (m) {
          currentMap = {};
          currentMap[m[1]] = m[2] === undefined ? null : parseScalar(m[2]);
          items.push(currentMap);
        } else {
          items.push(parseScalar(rest));
        }
      } else if (currentMap) {
        const m = KEY_LINE.exec(line.trim());
        if (!m) throw new FrontmatterParseError(`bad list-item line: ${line}`);
        currentMap[m[1]] = m[2] === undefined ? null : parseScalar(m[2]);
      } else {
        throw new FrontmatterParseError(`bad block list line: ${line}`);
      }
    }
    // Null placeholders from bare "-" lines carry nothing.
    return { value: items.filter((x) => x !== null), next: i };
  }

  const map: Record<string, unknown> = {};
  for (const line of stripped) {
    const m = KEY_LINE.exec(line.trim());
    if (!m) throw new FrontmatterParseError(`bad block map line: ${line}`);
    map[m[1]] = m[2] === undefined ? null : parseScalar(m[2]);
  }
  return { value: map, next: i };
}

function parseFrontmatterLines(lines: string[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    if (indentOf(line) !== 0) {
      throw new FrontmatterParseError(`unexpected indented line: ${line}`);
    }
    const m = KEY_LINE.exec(line);
    if (!m) throw new FrontmatterParseError(`unparseable frontmatter line: ${line}`);
    const key = m[1];
    if (m[2] !== undefined && m[2].trim() !== "") {
      fields[key] = parseScalar(m[2]);
      i++;
    } else {
      const { value, next } = parseBlock(lines, i + 1, 0);
      fields[key] = value;
      i = next;
    }
  }
  return fields;
}

/** Split a Markdown document into frontmatter fields and body. */
export function parseMarkdown(content: string): ParsedMarkdown {
  const text = content.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n") && text.trim() !== "---") {
    return { hasFrontmatter: false, frontmatterOk: true, fields: {}, body: text };
  }
  const lines = text.split("\n");
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---" || lines[i] === "...") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { hasFrontmatter: true, frontmatterOk: false, fields: {}, body: text };
  }
  const body = lines.slice(end + 1).join("\n");
  try {
    const fields = parseFrontmatterLines(lines.slice(1, end));
    return { hasFrontmatter: true, frontmatterOk: true, fields, body };
  } catch {
    return { hasFrontmatter: true, frontmatterOk: false, fields: {}, body };
  }
}

/** A field counts only if it has real content (`title:` alone earns nothing). */
export function isPopulated(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.some((v) => isPopulated(v));
  if (typeof value === "object") return Object.values(value).some((v) => isPopulated(v));
  return true;
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/* ------------------------------------------------------------------ */
/* Folder walking (shared by scan and trust)                           */
/* ------------------------------------------------------------------ */

interface WalkedFile {
  name: string;
  rel: string;
  full: string;
}

function walkMarkdown(root: string): { files: WalkedFile[]; skipped: SkippedEntry[] } {
  const files: WalkedFile[] = [];
  const skipped: SkippedEntry[] = [];
  const visit = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      skipped.push({
        name: prefix === "" ? path.basename(dir) : prefix,
        reason: `unreadable: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // hidden files/folders are skipped
      const full = path.join(dir, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        skipped.push({ name: entry.name, reason: "symlink (not followed)" });
      } else if (entry.isDirectory()) {
        visit(full, rel);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push({ name: entry.name, rel, full });
      }
    }
  };
  visit(root, "");
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, skipped };
}

function statOrThrow(p: string, tool: string): fs.Stats {
  try {
    return fs.statSync(p);
  } catch {
    throw new Error(`${tool}: path does not exist: ${p}`);
  }
}

/* ------------------------------------------------------------------ */
/* jidoseal_scan                                                       */
/* ------------------------------------------------------------------ */

function tierOf(fields: Record<string, unknown>, frontmatterOk: boolean): TierName {
  if (!frontmatterOk) return "none";
  const has = (f: string) => isPopulated(fields[f]);
  if (!has("type")) return "none";
  if (!SILVER_FIELDS.every(has)) return "bronze";
  if (!GOLD_FIELDS.every(has)) return "silver";
  return "gold";
}

function scanOne(name: string, content: Buffer): FileScan {
  const parsed = parseMarkdown(content.toString("utf8"));
  const fields = parsed.frontmatterOk ? parsed.fields : {};
  const present = TIER_FIELDS.filter((f) => isPopulated(fields[f]));
  const gaps = (list: readonly string[]): MissingEntry[] =>
    list.filter((f) => !isPopulated(fields[f])).map((f) => fixFor(f));
  const missing: FileScan["missing"] = {
    silver: gaps(SILVER_FIELDS),
    gold: gaps(GOLD_FIELDS),
  };
  if (!isPopulated(fields.type)) missing.bronze = gaps(BRONZE_FIELDS);
  return {
    name,
    tier: tierOf(fields, parsed.frontmatterOk),
    present,
    missing,
    frontmatter_ok: parsed.frontmatterOk,
    sha256: sha256Hex(content),
  };
}

export function scan(args: unknown, _opts: CoreOptions = {}): ScanResult {
  const { path: given } = validateScanArgs(args);
  const root = path.resolve(given);
  const st = statOrThrow(root, "jidoseal_scan");
  if (!st.isDirectory()) throw new Error(`jidoseal_scan: path is not a folder: ${given}`);

  const { files: walked, skipped } = walkMarkdown(root);
  const files: FileScan[] = [];
  for (const w of walked) {
    let content: Buffer;
    try {
      content = fs.readFileSync(w.full);
    } catch (err) {
      skipped.push({
        name: w.name,
        reason: `unreadable: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    files.push(scanOne(w.name, content));
  }

  const total = files.length;
  const reaching = (t: TierName) =>
    total === 0 ? 0 : Math.round((files.filter((f) => TIER_RANK[f.tier] >= TIER_RANK[t]).length / total) * 1000) / 10;
  const coverage = { bronze: reaching("bronze"), silver: reaching("silver"), gold: reaching("gold") };
  const corpusTier: TierName =
    total === 0 ? "none" : files.reduce<TierName>((min, f) => (TIER_RANK[f.tier] < TIER_RANK[min] ? f.tier : min), "gold");
  const score = total === 0 ? 0 : Math.round((coverage.bronze + coverage.silver + coverage.gold) / 3);
  const merkleRoot = sha256Hex(files.map((f) => f.sha256).join(""));

  return {
    corpus: { file_count: total, tier: corpusTier, coverage },
    files,
    skipped,
    certified_eligible: corpusTier !== "none",
    score,
    merkle_root: merkleRoot,
    audit_id: `scan-${merkleRoot.slice(0, 12)}`,
    rubric: {
      bronze: [...RUBRIC.bronze],
      silver: [...RUBRIC.silver],
      gold: [...RUBRIC.gold],
    },
  };
}

/* ------------------------------------------------------------------ */
/* jidoseal_trust                                                      */
/* ------------------------------------------------------------------ */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_NO_OFFSET = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/;
const OFFSET_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/i;

/** The timestamp carried by a trust field: a scalar, or `at` of an object. */
export function timestampString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const at = (value as Record<string, unknown>).at;
    if (typeof at === "string" && at.trim() !== "") return at;
  }
  return null;
}

/** Parse a date/datetime: bare dates compare as UTC midnight. */
export function parseTimestamp(value: unknown): Date | null {
  const s = timestampString(value);
  if (s === null) return null;
  const t = s.trim();
  if (DATE_ONLY.test(t)) {
    const [y, m, d] = t.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  const ms = Date.parse(DATETIME_NO_OFFSET.test(t) ? `${t.replace(" ", "T")}Z` : t);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** True when the value as written is a datetime carrying a UTC offset. */
function isDatetimeWithOffset(value: unknown): boolean {
  const s = timestampString(value);
  if (s === null) return false;
  const t = s.trim();
  return t.includes("T") && OFFSET_SUFFIX.test(t);
}

function which02(fields: Record<string, unknown>): string {
  if (isDatetimeWithOffset(fields.stale_after) || isDatetimeWithOffset(fields.usage_window)) {
    return "2026-08-21";
  }
  const sources = fields.sources;
  if (Array.isArray(sources)) {
    for (const item of sources) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        if (isDatetimeWithOffset((item as Record<string, unknown>).last_modified)) {
          return "2026-08-21";
        }
      }
    }
  }
  return "pre-2026-08-21";
}

function trustOne(name: string, content: string, now: Date): TrustResult {
  const parsed = parseMarkdown(content);
  const fields = parsed.frontmatterOk ? parsed.fields : {};

  const staleAfterTs = parseTimestamp(fields.stale_after);
  const stale = staleAfterTs !== null && staleAfterTs.getTime() < now.getTime();

  const verifiedPresent = isPopulated(fields.verified);
  const generatedTs = parseTimestamp(fields.generated);
  const verifiedTs = parseTimestamp(fields.verified);
  const generatedStr = timestampString(fields.generated);
  const verifiedStr = timestampString(fields.verified);

  let verdict: TrustResult["verdict"];
  let reasons: string[];
  if (stale) {
    verdict = "stale";
    reasons = [`stale_after ${timestampString(fields.stale_after)} is in the past`];
  } else if (!verifiedPresent) {
    verdict = "unverified";
    reasons = ["no verified field: the document has not been verified"];
  } else if (
    generatedTs !== null &&
    verifiedTs !== null &&
    generatedTs.getTime() > verifiedTs.getTime()
  ) {
    verdict = "unverified";
    reasons = [
      `content changed at ${generatedStr}, after its latest verification at ${verifiedStr}`,
    ];
  } else {
    verdict = "ok";
    reasons = [];
  }

  const statusRaw = fields.status;
  return {
    name,
    verdict,
    reasons,
    okf_conformant: isPopulated(fields.type),
    trust_tier: verifiedPresent ? "human-reviewed" : isPopulated(fields.generated) ? "generated" : "unverified",
    status: typeof statusRaw === "string" && statusRaw.trim() !== "" ? statusRaw : null,
    stale,
    which_0_2: which02(fields),
    verified: fields.verified ?? null,
    generated: fields.generated ?? null,
    stale_after: fields.stale_after ?? null,
  };
}

export function trust(args: unknown, opts: CoreOptions = {}): TrustResult | TrustFolderResult {
  const { path: given } = validateTrustArgs(args);
  const target = path.resolve(given);
  const st = statOrThrow(target, "jidoseal_trust");
  const now = opts.now ?? new Date();

  if (st.isFile()) {
    let content: string;
    try {
      content = fs.readFileSync(target, "utf8");
    } catch (err) {
      throw new Error(
        `jidoseal_trust: cannot read file: ${given} (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    return trustOne(path.basename(target), content, now);
  }
  if (!st.isDirectory()) throw new Error(`jidoseal_trust: path is not a file or folder: ${given}`);

  const { files: walked } = walkMarkdown(target);
  const files: TrustResult[] = [];
  for (const w of walked) {
    let content: string;
    try {
      content = fs.readFileSync(w.full, "utf8");
    } catch {
      continue; // unreadable files are simply not reported by trust
    }
    files.push(trustOne(w.name, content, now));
  }
  return { files };
}

/* ------------------------------------------------------------------ */
/* jidoseal_changes                                                    */
/* ------------------------------------------------------------------ */

export const defaultGitExecutor: GitExecutor = (args: string[]): GitExecResult => {
  try {
    const stdout = execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    });
    return { stdout, stderr: "", code: 0 };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; status?: unknown; message?: string };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : (e.message ?? String(err)),
      code: typeof e.status === "number" ? e.status : 1,
    };
  }
};

function serializeValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function diffFrontmatter(
  oldFields: Record<string, unknown>,
  newFields: Record<string, unknown>,
): FrontmatterChange[] {
  const keys: string[] = [];
  for (const k of Object.keys(oldFields)) if (!keys.includes(k)) keys.push(k);
  for (const k of Object.keys(newFields)) if (!keys.includes(k)) keys.push(k);
  const out: FrontmatterChange[] = [];
  for (const key of keys) {
    const from = serializeValue(oldFields[key]);
    const to = serializeValue(newFields[key]);
    if (from === to) continue;
    out.push({
      field: key,
      change: from === null ? "added" : to === null ? "removed" : "changed",
      from,
      to,
    });
  }
  return out;
}

function trustEffects(
  oldFields: Record<string, unknown>,
  newFields: Record<string, unknown>,
  fmChanges: FrontmatterChange[],
  bodyChanged: boolean,
): string[] {
  const effects: string[] = [];
  const verifiedRemoved = isPopulated(oldFields.verified) && !isPopulated(newFields.verified);
  const typeRemoved = isPopulated(oldFields.type) && !isPopulated(newFields.type);
  const verifiedUnchanged =
    isPopulated(oldFields.verified) &&
    isPopulated(newFields.verified) &&
    serializeValue(oldFields.verified) === serializeValue(newFields.verified);
  const textChanged = bodyChanged || fmChanges.length > 0;

  if (textChanged && verifiedUnchanged) {
    effects.push("verified document changed while verified did not");
  }
  if (verifiedRemoved) effects.push("verified removed");
  if (typeRemoved) effects.push("type removed");

  const generatedUnchanged =
    isPopulated(oldFields.generated) &&
    serializeValue(oldFields.generated) === serializeValue(newFields.generated);
  const otherChange = bodyChanged || fmChanges.some((c) => c.field !== "generated");
  if (generatedUnchanged && otherChange) {
    effects.push("generated.at not updated");
  }
  if (serializeValue(oldFields.status) !== serializeValue(newFields.status)) {
    effects.push("status changed");
  }
  if (serializeValue(oldFields.stale_after) !== serializeValue(newFields.stale_after)) {
    effects.push("stale_after changed");
  }
  return effects;
}

interface PorcelainEntry {
  xy: string;
  rel: string;
}

function parsePorcelain(stdout: string): PorcelainEntry[] {
  const out: PorcelainEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const xy = line.slice(0, 2);
    let rel = line.slice(3);
    if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1);
    const arrow = rel.indexOf(" -> ");
    if (arrow >= 0) rel = rel.slice(arrow + 4);
    if (!rel.endsWith(".md")) continue;
    out.push({ xy, rel });
  }
  return out;
}

export function changes(args: unknown, opts: CoreOptions = {}): ChangesResult {
  const { path: given, ref } = validateChangesArgs(args);
  const root = path.resolve(given);
  const st = statOrThrow(root, "jidoseal_changes");
  if (!st.isDirectory()) throw new Error(`jidoseal_changes: path is not a folder: ${given}`);
  const exec = opts.executor ?? defaultGitExecutor;
  const git = (rest: string[]): GitExecResult =>
    exec(["-c", "protocol.allow=never", "-C", root, ...rest]);

  const status = git(["status", "--porcelain"]);
  if (status.code !== 0) {
    const detail = status.stderr.trim() || `git exited with code ${status.code}`;
    throw new Error(`jidoseal_changes: git status failed in ${given}: ${detail}`);
  }

  const files: FileChange[] = [];
  for (const entry of parsePorcelain(status.stdout)) {
    const shown = git(["show", `${ref}:${entry.rel}`]);
    const oldContent = shown.code === 0 ? shown.stdout : null;

    const full = path.join(root, entry.rel);
    let newContent: string | null = null;
    try {
      newContent = fs.readFileSync(full, "utf8");
    } catch {
      newContent = null; // deleted in the working tree
    }
    if (oldContent === null && newContent === null) continue;

    const oldParsed = oldContent === null ? null : parseMarkdown(oldContent);
    const newParsed = newContent === null ? null : parseMarkdown(newContent);
    const oldFields = oldParsed && oldParsed.frontmatterOk ? oldParsed.fields : {};
    const newFields = newParsed && newParsed.frontmatterOk ? newParsed.fields : {};
    const fmChanges = diffFrontmatter(oldFields, newFields);
    const bodyChanged = (oldParsed?.body ?? "") !== (newParsed?.body ?? "");

    files.push({
      name: path.basename(entry.rel),
      path: entry.rel,
      is_new: oldContent === null,
      deleted: newContent === null,
      frontmatter_changes: fmChanges,
      body_changed: bodyChanged,
      trust_effects: trustEffects(oldFields, newFields, fmChanges, bodyChanged),
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { path: given, ref, files };
}
