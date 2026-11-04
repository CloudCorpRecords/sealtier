/**
 * sealtier core tests. All local: temporary folders on disk, a fixed
 * injected clock for trust, and a FAKE git executor for changes — no
 * network and no real git anywhere.
 *
 * The two scan suites reproduce the spec's published worked examples
 * as oracles: the clean all-Gold folder and the mixed folder from the
 * original README (expenses.md / leave-policy.md / notes.md).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { changes, parseMarkdown, scan, trust } from "../src/core.js";
import type { GitExecutor, ScanResult, TrustResult } from "../src/types.js";

const NOW = new Date("2026-10-27T00:00:00Z");

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sealtier-test-"));
}

function write(dir: string, name: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

function goldFile(type: string, title: string): string {
  return [
    "---",
    `type: ${type}`,
    `title: ${title}`,
    "description: A complete description.",
    "timestamp: 2026-09-01",
    "owner: dept:people-ops",
    "status: stable",
    "review_policy: yearly",
    "reviewed_at: 2026-09-01",
    "next_review_at: 2027-09-01",
    "---",
    "",
    "Body text.",
    "",
  ].join("\n");
}

function byName(result: ScanResult, name: string) {
  const f = result.files.find((x) => x.name === name);
  assert.ok(f, `expected file ${name} in scan result`);
  return f;
}

/* ------------------------------------------------------------------ */
/* Scan — worked example 1: the clean folder                           */
/* ------------------------------------------------------------------ */

describe("scan: clean folder (worked example)", () => {
  it("reports an all-Gold corpus exactly as the spec's clean example", () => {
    const dir = tmpDir();
    write(dir, "report.md", goldFile("report", "Quarterly report"));
    write(dir, "guide.md", goldFile("guide", "Onboarding guide"));

    const result = scan({ path: dir });
    assert.equal(result.corpus.file_count, 2);
    assert.equal(result.corpus.tier, "gold");
    assert.deepEqual(result.corpus.coverage, { bronze: 100, silver: 100, gold: 100 });
    assert.equal(result.score, 100);
    assert.equal(result.certified_eligible, true);
    assert.deepEqual(result.skipped, []);

    const report = byName(result, "report.md");
    assert.equal(report.tier, "gold");
    assert.deepEqual(report.present, [
      "type",
      "title",
      "description",
      "timestamp",
      "owner",
      "status",
      "review_policy",
      "reviewed_at",
      "next_review_at",
    ]);
    assert.deepEqual(report.missing.silver, []);
    assert.deepEqual(report.missing.gold, []);
    assert.equal(report.frontmatter_ok, true);
  });

  it("computes the Merkle root and audit id by the disclosed construction", () => {
    const dir = tmpDir();
    write(dir, "a.md", goldFile("note", "A"));
    write(dir, "b.md", goldFile("note", "B"));
    const result = scan({ path: dir });
    const concat = result.files.map((f) => f.sha256).join("");
    const expected = createHash("sha256").update(concat).digest("hex");
    assert.equal(result.merkle_root, expected);
    assert.equal(result.audit_id, `scan-${expected.slice(0, 12)}`);
    for (const f of result.files) {
      const raw = fs.readFileSync(path.join(dir, f.name));
      assert.equal(f.sha256, createHash("sha256").update(raw).digest("hex"));
    }
  });

  it("carries the tier rubric", () => {
    const dir = tmpDir();
    write(dir, "a.md", goldFile("note", "A"));
    const result = scan({ path: dir });
    assert.deepEqual(result.rubric.bronze, ["type"]);
    assert.deepEqual(result.rubric.silver, ["type", "title", "description", "timestamp", "owner"]);
    assert.equal(result.rubric.gold.length, 9);
  });
});

/* ------------------------------------------------------------------ */
/* Scan — worked example 2: the mixed folder                           */
/* ------------------------------------------------------------------ */

describe("scan: mixed folder (worked example)", () => {
  function mixedDir(): string {
    const dir = tmpDir();
    write(
      dir,
      "expenses.md",
      ["---", "type: record", "title: Expenses", "---", "", "Numbers.", ""].join("\n"),
    );
    write(dir, "leave-policy.md", goldFile("policy", "Leave policy"));
    write(dir, "notes.md", "# Notes\n\nNo frontmatter at all.\n");
    return dir;
  }

  it("matches the published corpus summary: tier none, coverage 66.7/33.3/33.3, score 44", () => {
    const result = scan({ path: mixedDir() });
    assert.equal(result.corpus.file_count, 3);
    assert.equal(result.corpus.tier, "none");
    assert.deepEqual(result.corpus.coverage, { bronze: 66.7, silver: 33.3, gold: 33.3 });
    assert.equal(result.score, 44);
    assert.equal(result.certified_eligible, false);
    assert.deepEqual(result.skipped, []);
  });

  it("expenses.md: bronze, present [type, title], exact Silver gaps", () => {
    const result = scan({ path: mixedDir() });
    const f = byName(result, "expenses.md");
    assert.equal(f.tier, "bronze");
    assert.deepEqual(f.present, ["type", "title"]);
    assert.deepEqual(f.missing.silver, [
      { field: "description", fix: "AUTO" },
      { field: "timestamp", fix: "AUTO" },
      { field: "owner", fix: "NEEDS-CLIENT" },
    ]);
    assert.deepEqual(f.missing.gold, [
      { field: "status", fix: "NEEDS-CLIENT" },
      { field: "review_policy", fix: "NEEDS-CLIENT" },
      { field: "reviewed_at", fix: "NEEDS-CLIENT" },
      { field: "next_review_at", fix: "NEEDS-CLIENT" },
    ]);
    assert.equal(f.missing.bronze, undefined);
  });

  it("notes.md: tier none, first missing Bronze entry is the pinned type proposal", () => {
    const result = scan({ path: mixedDir() });
    const f = byName(result, "notes.md");
    assert.equal(f.tier, "none");
    assert.deepEqual(f.present, []);
    assert.ok(f.missing.bronze);
    assert.deepEqual(f.missing.bronze[0], {
      field: "type",
      fix: "AUTO",
      value: "note",
      confidence: "MEDIUM",
      inferred: true,
    });
    assert.deepEqual(f.missing.silver, [
      { field: "title", fix: "AUTO" },
      { field: "description", fix: "AUTO" },
      { field: "timestamp", fix: "AUTO" },
      { field: "owner", fix: "NEEDS-CLIENT" },
    ]);
    assert.equal(f.frontmatter_ok, true); // no block at all is not a parse failure
  });

  it("leave-policy.md: gold with empty gap lists", () => {
    const result = scan({ path: mixedDir() });
    const f = byName(result, "leave-policy.md");
    assert.equal(f.tier, "gold");
    assert.deepEqual(f.missing, { silver: [], gold: [] });
  });
});

/* ------------------------------------------------------------------ */
/* Scan — parser and walking behaviour                                 */
/* ------------------------------------------------------------------ */

describe("scan: parser and walking", () => {
  it("marks an unparseable frontmatter block frontmatter_ok:false and tier none", () => {
    const dir = tmpDir();
    write(dir, "bad.md", '---\ntype: note\ntitle: "unclosed quote\n---\nbody\n');
    const result = scan({ path: dir });
    const f = byName(result, "bad.md");
    assert.equal(f.frontmatter_ok, false);
    assert.equal(f.tier, "none");
    assert.deepEqual(f.present, []);
  });

  it("an empty value earns nothing: `title:` with no content does not count", () => {
    const dir = tmpDir();
    write(dir, "partial.md", "---\ntype: note\ntitle:\n---\nbody\n");
    const result = scan({ path: dir });
    const f = byName(result, "partial.md");
    assert.equal(f.tier, "bronze");
    assert.deepEqual(f.present, ["type"]);
  });

  it("quoted values count as populated", () => {
    const dir = tmpDir();
    write(dir, "q.md", '---\ntype: "note"\ntitle: \'Quoted\'\n---\nbody\n');
    const f = byName(scan({ path: dir }), "q.md");
    assert.deepEqual(f.present, ["type", "title"]);
  });

  it("scans recursively and reports base names", () => {
    const dir = tmpDir();
    write(dir, "sub/inner.md", goldFile("note", "Inner"));
    const result = scan({ path: dir });
    assert.equal(result.corpus.file_count, 1);
    assert.equal(result.files[0].name, "inner.md");
    assert.equal(result.corpus.tier, "gold");
  });

  it("never follows symlinks: they land in skipped", () => {
    const dir = tmpDir();
    const target = tmpDir();
    write(target, "real.md", goldFile("note", "Real"));
    fs.symlinkSync(path.join(target, "real.md"), path.join(dir, "link.md"));
    write(dir, "own.md", goldFile("note", "Own"));
    const result = scan({ path: dir });
    assert.equal(result.corpus.file_count, 1);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].name, "link.md");
  });

  it("skips hidden files and non-Markdown files", () => {
    const dir = tmpDir();
    write(dir, ".hidden.md", goldFile("note", "Hidden"));
    write(dir, "notes.txt", goldFile("note", "Text"));
    write(dir, "visible.md", goldFile("note", "Visible"));
    const result = scan({ path: dir });
    assert.equal(result.corpus.file_count, 1);
    assert.equal(result.files[0].name, "visible.md");
  });

  it("handles an empty folder: no files, tier none, score 0, not eligible", () => {
    const result = scan({ path: tmpDir() });
    assert.equal(result.corpus.file_count, 0);
    assert.equal(result.corpus.tier, "none");
    assert.deepEqual(result.corpus.coverage, { bronze: 0, silver: 0, gold: 0 });
    assert.equal(result.score, 0);
    assert.equal(result.certified_eligible, false);
  });

  it("parseMarkdown reads a nested generated.at block and a sources list", () => {
    const parsed = parseMarkdown(
      [
        "---",
        "type: doc",
        "generated:",
        "  at: 2026-09-01T00:00:00Z",
        "sources:",
        "  - last_modified: 2026-09-01T00:00:00+00:00",
        "---",
        "body",
      ].join("\n"),
    );
    assert.equal(parsed.frontmatterOk, true);
    assert.deepEqual(parsed.fields.generated, { at: "2026-09-01T00:00:00Z" });
    assert.deepEqual(parsed.fields.sources, [{ last_modified: "2026-09-01T00:00:00+00:00" }]);
    assert.equal(parsed.body, "body");
  });
});

/* ------------------------------------------------------------------ */
/* Trust                                                               */
/* ------------------------------------------------------------------ */

describe("trust", () => {
  it("reproduces the published unverified example exactly", () => {
    const dir = tmpDir();
    write(
      dir,
      "leave.md",
      [
        "---",
        "type: policy",
        "title: Leave policy",
        "status: stable",
        "generated: 2026-10-01T00:00:00Z",
        "verified: 2026-06-25T09:00:00Z",
        "stale_after: 2027-01-01T00:00:00+00:00",
        "---",
        "body",
      ].join("\n"),
    );
    const r = trust({ path: path.join(dir, "leave.md") }, { now: NOW }) as TrustResult;
    assert.equal(r.verdict, "unverified");
    assert.deepEqual(r.reasons, [
      "content changed at 2026-10-01T00:00:00Z, after its latest verification at 2026-06-25T09:00:00Z",
    ]);
    assert.equal(r.okf_conformant, true);
    assert.equal(r.trust_tier, "human-reviewed");
    assert.equal(r.status, "stable");
    assert.equal(r.stale, false);
    assert.equal(r.which_0_2, "2026-08-21");
    assert.equal(r.verified, "2026-06-25T09:00:00Z");
    assert.equal(r.generated, "2026-10-01T00:00:00Z");
  });

  it("verdict stale when stale_after lies in the past (bare date, pre-2026-08-21 text)", () => {
    const dir = tmpDir();
    write(
      dir,
      "old.md",
      [
        "---",
        "type: policy",
        "generated: 2026-06-20T00:00:00Z",
        "verified: 2026-06-25T09:00:00Z",
        "stale_after: 2026-01-01",
        "---",
        "body",
      ].join("\n"),
    );
    const r = trust({ path: path.join(dir, "old.md") }, { now: NOW }) as TrustResult;
    assert.equal(r.verdict, "stale");
    assert.equal(r.stale, true);
    assert.equal(r.which_0_2, "pre-2026-08-21");
    assert.equal(r.trust_tier, "human-reviewed");
  });

  it("verdict ok when verified is the latest timestamp and nothing is stale", () => {
    const dir = tmpDir();
    write(
      dir,
      "fine.md",
      [
        "---",
        "type: note",
        "generated: 2026-06-20T00:00:00Z",
        "verified: 2026-06-25T09:00:00Z",
        "stale_after: 2027-01-01",
        "---",
        "body",
      ].join("\n"),
    );
    const r = trust({ path: path.join(dir, "fine.md") }, { now: NOW }) as TrustResult;
    assert.equal(r.verdict, "ok");
    assert.deepEqual(r.reasons, []);
    assert.equal(r.stale, false);
    assert.equal(r.status, null);
  });

  it("no verified field: unverified, trust_tier generated when only generated is present", () => {
    const dir = tmpDir();
    write(dir, "gen.md", "---\ntype: note\ngenerated: 2026-06-20T00:00:00Z\n---\nbody\n");
    const r = trust({ path: path.join(dir, "gen.md") }, { now: NOW }) as TrustResult;
    assert.equal(r.verdict, "unverified");
    assert.equal(r.trust_tier, "generated");
    assert.match(r.reasons[0], /no verified field/);
  });

  it("no frontmatter at all: unverified, not conformant, trust_tier unverified", () => {
    const dir = tmpDir();
    write(dir, "bare.md", "# Just a heading\n");
    const r = trust({ path: path.join(dir, "bare.md") }, { now: NOW }) as TrustResult;
    assert.equal(r.verdict, "unverified");
    assert.equal(r.okf_conformant, false);
    assert.equal(r.trust_tier, "unverified");
    assert.equal(r.which_0_2, "pre-2026-08-21");
  });

  it("a generated object with at: compares by its at timestamp", () => {
    const dir = tmpDir();
    write(
      dir,
      "obj.md",
      [
        "---",
        "type: doc",
        "generated:",
        "  at: 2026-10-01T00:00:00Z",
        "verified: 2026-06-25T09:00:00Z",
        "---",
        "body",
      ].join("\n"),
    );
    const r = trust({ path: path.join(dir, "obj.md") }, { now: NOW }) as TrustResult;
    assert.equal(r.verdict, "unverified");
    assert.deepEqual(r.reasons, [
      "content changed at 2026-10-01T00:00:00Z, after its latest verification at 2026-06-25T09:00:00Z",
    ]);
    assert.deepEqual(r.generated, { at: "2026-10-01T00:00:00Z" });
  });

  it("folder input returns one verdict per file, sorted by name", () => {
    const dir = tmpDir();
    write(dir, "b-ok.md", "---\ntype: note\nverified: 2026-06-25T09:00:00Z\n---\nbody\n");
    write(dir, "a-stale.md", "---\ntype: note\nstale_after: 2020-01-01\n---\nbody\n");
    const r = trust({ path: dir }, { now: NOW }) as { files: TrustResult[] };
    assert.equal(r.files.length, 2);
    assert.equal(r.files[0].name, "a-stale.md");
    assert.equal(r.files[0].verdict, "stale");
    assert.equal(r.files[1].name, "b-ok.md");
    assert.equal(r.files[1].verdict, "ok");
  });
});

/* ------------------------------------------------------------------ */
/* Changes (fake git executor only — no real git)                      */
/* ------------------------------------------------------------------ */

interface FakeGitSpec {
  status: string;
  shows?: Record<string, string>;
  statusCode?: number;
  statusStderr?: string;
}

function fakeGit(spec: FakeGitSpec): { exec: GitExecutor; calls: string[][] } {
  const calls: string[][] = [];
  const exec: GitExecutor = (args) => {
    calls.push([...args]);
    if (args.includes("status")) {
      return { stdout: spec.status, stderr: spec.statusStderr ?? "", code: spec.statusCode ?? 0 };
    }
    if (args.includes("show")) {
      const specArg = args[args.length - 1];
      const rel = specArg.slice(specArg.indexOf(":") + 1);
      if (spec.shows && rel in spec.shows) return { stdout: spec.shows[rel], stderr: "", code: 0 };
      return { stdout: "", stderr: `fatal: path '${rel}' does not exist in 'HEAD'`, code: 128 };
    }
    return { stdout: "", stderr: "unexpected git invocation", code: 1 };
  };
  return { exec, calls };
}

const EDITED_OLD = [
  "---",
  "type: doc",
  "title: Old title",
  "verified: 2026-06-25T09:00:00Z",
  "generated: 2026-06-20T00:00:00Z",
  "---",
  "old body",
  "",
].join("\n");
const EDITED_NEW = EDITED_OLD.replace("Old title", "New title").replace("old body", "new body");

const GEN_OLD = [
  "---",
  "type: doc",
  "generated:",
  "  at: 2026-09-01T00:00:00Z",
  "---",
  "old body",
  "",
].join("\n");

describe("changes", () => {
  function changesDir(): string {
    const dir = tmpDir();
    write(dir, "edited.md", EDITED_NEW);
    write(dir, "unverified.md", "---\ntype: doc\n---\nsame body\n");
    write(dir, "typed.md", "---\ntitle: T\n---\nbody\n");
    write(
      dir,
      "status.md",
      "---\ntype: doc\nstatus: stable\nstale_after: 2027-06-01\n---\nbody\n",
    );
    write(dir, "gen.md", GEN_OLD.replace("old body", "edited body"));
    write(dir, "new.md", "---\ntype: note\n---\nbrand new\n");
    return dir;
  }

  function runChanges(dir: string) {
    const fake = fakeGit({
      status: " M edited.md\n M unverified.md\n M typed.md\n M status.md\n M gen.md\n?? new.md\n",
      shows: {
        "edited.md": EDITED_OLD,
        "unverified.md": "---\ntype: doc\nverified: 2026-06-25T09:00:00Z\n---\nsame body\n",
        "typed.md": "---\ntype: doc\ntitle: T\n---\nbody\n",
        "status.md": "---\ntype: doc\nstatus: draft\nstale_after: 2027-01-01\n---\nbody\n",
        "gen.md": GEN_OLD,
      },
    });
    const result = changes({ path: dir }, { executor: fake.exec });
    return { result, calls: fake.calls };
  }

  it("always invokes git with transports disabled (protocol.allow=never)", () => {
    const { calls } = runChanges(changesDir());
    assert.ok(calls.length >= 2);
    for (const c of calls) {
      assert.equal(c[0], "-c");
      assert.equal(c[1], "protocol.allow=never");
    }
  });

  it("edited verified doc: frontmatter diff, body change, verified + generated trust effects", () => {
    const { result } = runChanges(changesDir());
    const f = result.files.find((x) => x.name === "edited.md");
    assert.ok(f);
    assert.equal(f.is_new, false);
    assert.equal(f.body_changed, true);
    assert.deepEqual(f.frontmatter_changes, [
      { field: "title", change: "changed", from: "Old title", to: "New title" },
    ]);
    assert.ok(f.trust_effects.includes("verified document changed while verified did not"));
    assert.ok(f.trust_effects.includes("generated.at not updated"));
  });

  it("verified removed is reported, and not double-reported as unchanged", () => {
    const { result } = runChanges(changesDir());
    const f = result.files.find((x) => x.name === "unverified.md");
    assert.ok(f);
    assert.deepEqual(f.frontmatter_changes, [
      { field: "verified", change: "removed", from: "2026-06-25T09:00:00Z", to: null },
    ]);
    assert.ok(f.trust_effects.includes("verified removed"));
    assert.ok(!f.trust_effects.includes("verified document changed while verified did not"));
  });

  it("type removed is reported", () => {
    const { result } = runChanges(changesDir());
    const f = result.files.find((x) => x.name === "typed.md");
    assert.ok(f);
    assert.ok(f.trust_effects.includes("type removed"));
  });

  it("status and stale_after changes are reported as trust effects", () => {
    const { result } = runChanges(changesDir());
    const f = result.files.find((x) => x.name === "status.md");
    assert.ok(f);
    assert.ok(f.trust_effects.includes("status changed"));
    assert.ok(f.trust_effects.includes("stale_after changed"));
    assert.equal(f.body_changed, false);
  });

  it("generated.at not updated: nested generated block unchanged while the body changed", () => {
    const { result } = runChanges(changesDir());
    const f = result.files.find((x) => x.name === "gen.md");
    assert.ok(f);
    assert.deepEqual(f.frontmatter_changes, []);
    assert.equal(f.body_changed, true);
    assert.ok(f.trust_effects.includes("generated.at not updated"));
  });

  it("a file absent at the ref is new, with every field added and no trust effects", () => {
    const { result } = runChanges(changesDir());
    const f = result.files.find((x) => x.name === "new.md");
    assert.ok(f);
    assert.equal(f.is_new, true);
    assert.deepEqual(f.frontmatter_changes, [
      { field: "type", change: "added", from: null, to: "note" },
    ]);
    assert.deepEqual(f.trust_effects, []);
  });

  it("honours an explicit ref in the git show invocation", () => {
    const dir = tmpDir();
    write(dir, "edited.md", EDITED_NEW);
    const fake = fakeGit({ status: " M edited.md\n", shows: { "edited.md": EDITED_OLD } });
    const result = changes({ path: dir, ref: "v1.2" }, { executor: fake.exec });
    assert.equal(result.ref, "v1.2");
    const showCall = fake.calls.find((c) => c.includes("show"));
    assert.ok(showCall);
    assert.equal(showCall[showCall.length - 1], "v1.2:edited.md");
  });

  it("defaults the ref to HEAD", () => {
    const dir = tmpDir();
    write(dir, "edited.md", EDITED_NEW);
    const fake = fakeGit({ status: " M edited.md\n", shows: { "edited.md": EDITED_OLD } });
    const result = changes({ path: dir }, { executor: fake.exec });
    assert.equal(result.ref, "HEAD");
  });

  it("git failure returns an honest error naming the failure", () => {
    const dir = tmpDir();
    const fake = fakeGit({
      status: "",
      statusCode: 128,
      statusStderr: "fatal: not a git repository (or any of the parent directories): .git",
    });
    assert.throws(
      () => changes({ path: dir }, { executor: fake.exec }),
      /git status failed.*not a git repository/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Argument validation                                                 */
/* ------------------------------------------------------------------ */

describe("argument validation", () => {
  it("scan rejects non-object arguments", () => {
    assert.throws(() => scan(null), /arguments must be an object/);
    assert.throws(() => scan("a string"), /arguments must be an object/);
  });

  it("scan rejects a missing, non-string, or blank path", () => {
    assert.throws(() => scan({}), /"path" is required/);
    assert.throws(() => scan({ path: 42 }), /"path" is required/);
    assert.throws(() => scan({ path: "   " }), /"path" is required/);
  });

  it("scan rejects a nonexistent path and a file passed as a folder", () => {
    assert.throws(() => scan({ path: "/nonexistent/sealtier/nope" }), /path does not exist/);
    const dir = tmpDir();
    write(dir, "f.md", goldFile("note", "F"));
    assert.throws(() => scan({ path: path.join(dir, "f.md") }), /not a folder/);
  });

  it("trust rejects bad arguments and nonexistent paths", () => {
    assert.throws(() => trust({}), /"path" is required/);
    assert.throws(() => trust({ path: 7 }), /"path" is required/);
    assert.throws(() => trust({ path: "/nonexistent/sealtier/nope.md" }), /path does not exist/);
  });

  it("changes rejects a non-string ref and a missing path", () => {
    const dir = tmpDir();
    assert.throws(() => changes({ path: dir, ref: 42 }), /"ref" must be/);
    assert.throws(() => changes({}), /"path" is required/);
    assert.throws(() => changes({ path: "/nonexistent/sealtier/nope" }), /path does not exist/);
  });
});
