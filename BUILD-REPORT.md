# sealtier — Build Report

MCP Rebuild 100, batch 27. Clean-room rebuild of `com.jidoseal/jidoseal-mcp`
(PyPI `jidoseal-mcp` v0.2.0), built from `specs-batch27/sealtier.md` and
`harness/fixtures/jidoseal-tools-original.json` only. Local build only —
nothing pushed or published.

Identity: repo `sealtier`, npm `@reneturcios/sealtier`, MCP name
`io.github.CloudCorpRecords/sealtier`, version `0.1.0`. A local,
read-only OKF v0.2 tier checker for Markdown folders: 3 of the
original's 5 tools (see Omissions).

## Files created (19/19 per TEMPLATE.md checklist, plus this report and parity output)

- `package.json` — bin `sealtier: dist/cli.js`, `mcpName` set, scripts
  build=`tsc` / dev=`tsx src/cli.ts` / test=`tsx --test test/*.test.ts`
- `server.json` — description "Local OKF tier check for Markdown
  folders: scan tiers, trust verdicts and git change reports." =
  **93 chars** (≤100 ✓); npm entry carries `version: 0.1.0`; OCI entry
  `ghcr.io/cloudcorprecords/sealtier:0.1.0` carries **no** `version`
  field (verified programmatically)
- `Dockerfile` — node:20-alpine two-stage, ENTRYPOINT
  `node /app/dist/cli.js`, CMD `mcp`, label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/sealtier"`
- `tsconfig.json` (byte-identical to the fleet template, 318 bytes),
  `.gitignore`, `LICENSE` (MIT, Copyright (c) 2026 Rene Turcios),
  `README.md` (fresh text), `CHANGELOG.md` (single 0.1.0 entry,
  2026-10-27)
- `src/index.ts`, `src/cli.ts` (`jidoseal_scan` / `jidoseal_trust` /
  `jidoseal_changes` with a JSON argument, `mcp`, `--version`; exit 2
  usage / 1 tool error), `src/mcp.ts`, `src/types.ts`, `src/core.ts`
  (core logic, `VERSION = "0.1.0"`, injectable fs root path, clock
  `now`, and git executor)
- `test/core.test.ts` — 37 tests
- `.github/workflows/{ci,publish,publish-container,registry-publish}.yml`
  (fleet mechanics; image name and smoke-test server name adapted)
- `parity-out/` — harness output (see Verification §4)

## Omissions (2 of the original's 5 tools, per spec)

- `jidoseal_start_checkout` — **omitted under the program SAFETY
  RULE**: it asks jidoseal.com to create a Stripe Checkout session for
  a paid certificate (a payment funnel).
- `jidoseal_certification_offer` — **omitted**: its decisive output is
  a price, and the README states prices are published only on
  jidoseal.com; the price is not in the readable record and was not
  invented.

## Implementation notes

- Core (`src/core.ts`) is pure local computation over an injected
  folder path, with an injectable clock (`now`, for trust's "in the
  past") and an injectable git executor (changes). Tests use temporary
  folders, a fixed clock, and a **fake executor only — no real git
  runs in tests**, no network anywhere.
- The default git executor runs the local `git` with
  `-c protocol.allow=never`, `-C <folder>`, and `GIT_NO_LAZY_FETCH=1`
  in the environment (transports disabled, as pinned).
- **Deviation from the TEMPLATE §2.12 pattern, with reason (program
  standing rule):** `src/mcp.ts` uses the SDK's low-level `Server`
  instead of `McpServer`. The `McpServer`/zod path injects `$schema`
  and `additionalProperties` into every inputSchema, breaking exact
  parity with the fixture. `tools/list` is served from explicit
  literals copied from the fixture; the core validates every
  `tools/call` argument itself (no zod on the call path).

## Every labelled reconstruction / deviation from the spec

Pinned behaviour was implemented exactly as specified. The following
are the spec's LABELLED RECONSTRUCTIONs plus my reconciliations where
the record was silent — nothing here was silently invented:

1. **Argument names** (reconstruction, spec-labelled): `path`
   (string, required) for all three tools; `ref` (string, optional,
   default `HEAD` — the default itself is pinned) for
   `jidoseal_changes`. The README pins the concepts, not arg names.
2. **Score formula** (reconstruction): `round(mean(coverage.bronze,
   coverage.silver, coverage.gold))`. Reproduces both published
   values: 44 for 66.7/33.3/33.3 and 100 for the clean folder.
3. **Merkle root** (reconstruction): hex sha256 of the concatenation
   of the per-file sha256 hex digests (of raw file contents), files
   ordered by name. Each file entry carries its `sha256`. Empty
   corpus: sha256 of the empty string.
4. **Audit id** (reconstruction): `scan-<first 12 hex chars of the
   Merkle root>`.
5. **`certified_eligible`** (reconstruction): `true` iff the corpus
   tier is not `none`.
6. **`rubric`** (reconstruction of shape): the tier→fields mapping,
   emitted cumulatively (bronze ⊂ silver ⊂ gold).
7. **Gold fix marks** (reconstruction): `status`, `review_policy`,
   `reviewed_at`, `next_review_at` → `NEEDS-CLIENT` (governance facts
   only the owner can state). Pinned marks kept exact: `title`,
   `description`, `timestamp` → `AUTO`; `owner` → `NEEDS-CLIENT`;
   missing `type` → `{field:"type", fix:"AUTO", value:"note",
   confidence:"MEDIUM", inferred:true}`.
8. **`missing` key shape** (reconciliation — see Ambiguities): the
   `silver` and `gold` lists are always present (empty when that
   tier's own fields are all populated, matching the README's Gold
   example `{silver: [], gold: []}`); the `bronze` list is present
   only when `type` itself is missing.
9. **`skipped`** (reconstruction): files that exist but cannot be
   read, and symlinks (never followed), each `{name, reason}`. Hidden
   files/folders are skipped silently (per README).
10. **Read-only DEVIATION**: the original writes
    `.jidoseal/manifest.json` and `.jidoseal/progress.ndjson` under
    the scanned folder and names those paths in its result. This
    rebuild writes nothing anywhere and omits the written-paths
    fields.
11. **YAML subset** (disclosed): frontmatter parsing is a hand-rolled
    subset — flat `key: value` pairs, quoted strings, inline
    lists/maps, one level of indented block maps/lists (enough for
    `generated: {at: ...}` block form and `sources[].last_modified`).
    A block outside the subset counts as unparseable
    (`frontmatter_ok: false`, no tier, no fields). Alias handling
    beyond the nine named tier fields is out of scope — the README's
    `docs/tiers.md` field reference lives only in the unread repo
    (spec-recorded gap).
12. **`trust_tier` mapping** (reconstruction of OKF §5.3, whose table
    is not published): `human-reviewed` when a `verified` field is
    present, `generated` when only `generated` is present, else
    `unverified`.
13. **`which_0_2`** (reconstruction): `"2026-08-21"` when
    `stale_after`, `sources[].last_modified`, or `usage_window` is a
    datetime carrying a UTC offset, else `"pre-2026-08-21"`. Both
    bare-date and datetime forms are accepted everywhere; bare dates
    compare as UTC midnight.
14. **Trust reason wordings**: the changed-after-verification reason
    is pinned verbatim ("content changed at <ts>, after its latest
    verification at <ts>", timestamps as written). The no-`verified`
    reason ("no verified field: the document has not been verified")
    and the stale reason ("stale_after <ts> is in the past") are
    reconstructions of wording — the spec labels the former's wording
    a reconstruction and does not publish the latter.
15. **Scalar `generated`** (reconstruction): treated as its own
    timestamp; an object `generated` is compared by its `at`.
16. **Changes executor mechanics** (reconstruction): changed set from
    `git status --porcelain`, old version from `git show <ref>:<path>`,
    new version from the working tree; a file absent at the ref is
    "new". The per-file output shape (`frontmatter_changes` with
    added/removed/changed + from/to, `body_changed`, `is_new`,
    `deleted`) and the trust-effect strings ("verified document
    changed while verified did not", "verified removed",
    "type removed", "generated.at not updated", "status changed",
    "stale_after changed") are my wording for the spec's pinned
    effect list. A git failure returns an honest error naming the
    failure (e.g. "git status failed in …: fatal: not a git
    repository").
17. **Trust folder wrapper** (not pinned): a single file returns the
    bare verdict object (the README example's shape); a folder
    returns `{files: [...]}` sorted by name.

## Ambiguities hit (flagged, not silently resolved)

- The spec text says `missing` holds "one entry per unreached tier",
  but the README's Gold example shows `missing: {silver: [], gold: []}`
  (empty lists for *reached* tiers, and no `bronze` key). I followed
  the worked example (item 8 above); under the spec-text reading a
  Gold file's `missing` would be `{}`.
- When a file is both stale and changed-after-verification, the spec
  pins both verdict rules but no precedence. I report `stale` (the
  spec lists it first, and `stale` is also a separate boolean).
- The README's trust example shows `which_0_2: "2026-08-21"` while its
  visible fields (`generated`, `verified`) are not among the three
  checked fields; the example is explicitly trimmed ("plus each
  timestamp as written"), so a trimmed offset-carrying field is
  presumed. My oracle test reproduces the value with a future
  `stale_after` datetime carrying an offset.

## Verification (exact outputs)

### 1. Typecheck and build
```
$ npx tsc --noEmit ; echo exit=$?
exit=0
$ npm run build && chmod +x dist/cli.js
dist/cli.js first line: #!/usr/bin/env node
$ node dist/cli.js --version
0.1.0
```

### 2. Tests
```
$ npm test   (tsx --test test/*.test.ts)
ℹ tests 37
ℹ pass 37
ℹ fail 0
```
Coverage includes: both published scan worked examples as oracles
(clean folder — file_count 2, corpus gold, coverage 100/100/100,
score 100, certified_eligible true, report.md `present` exactly the
nine tier fields in tier order; mixed folder — file_count 3, corpus
`none`, coverage 66.7/33.3/33.3, score 44, certified_eligible false,
expenses.md Silver gaps and notes.md Bronze type proposal
byte-exact); Merkle/audit-id construction; rubric; parse-failure
(`frontmatter_ok: false`), empty-value, quoted-value, recursion,
symlink-skipped, hidden-file, and empty-folder cases; trust
stale/unverified/ok, the published unverified example byte-exact
(reason string, trust_tier, which_0_2), no-verified and
`generated.at`-object cases, folder mode; changes trust effects
(verified-unchanged, verified removed, type removed, status /
stale_after changed, generated.at not updated, new file), ref
defaulting and honouring, transports-disabled assertion on every
fake-executor call, and git-failure error; argument validation for
all three tools.

### 3. CLI / MCP smoke
CLI `jidoseal_scan` on the mixed fixture reproduced the oracle
(corpus none, 66.7/33.3/33.3, score 44); unknown command exits 2 with
Usage; nonexistent path exits 1 naming the failure. Over stdio MCP:
`initialize` → `serverInfo {name: "sealtier", version: "0.1.0"}`;
`tools/call jidoseal_scan` returned the oracle corpus with
`audit_id: scan-…`; a call with `{}` returned `isError: true` with
the core's validation message.

### 4. Parity (harness, from ~/workspace/mcp-rebuild-100/harness/)
```
$ python3 parity.py --original fixtures/jidoseal-tools-original.json \
    --rebuild "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/sealtier/dist/cli.js mcp" \
    --out /home/hatch/workspace/mcp-rebuild-100/builds/sealtier/parity-out
verdict=PASS parity_pct=100.0 original_tools=3 rebuild_tools=3 missing=[] extra=[] schema_diffs=[]
(exit 0)
```
(The original side is a tools file, so the harness compares the
served tools/list against the fixture — structural parity PASS.)

## Lockfile status

`package-lock.json` generated clean (no `node_modules` present) via
LOCKFILE-ROUTE.md Route 3:
`npm install --package-lock-only --ignore-scripts --offline` —
verified: parses, `name` = `@reneturcios/sealtier`, version 0.1.0,
lockfileVersion 3, **128 package entries**. Dependencies for the
local build/test were installed from the same offline cache
(`npm install --ignore-scripts --offline`, 0 vulnerabilities).

## Blockers

None for the local build. Notes for the publish wave:
- Container build not exercised locally (no Docker run in this wave);
  the publish-container workflow smoke-tests the image at publish
  time.
