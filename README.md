# sealtier

sealtier checks a folder of Markdown files against the Open Knowledge
Format (OKF) v0.2 frontmatter tiers — Bronze, Silver, Gold — entirely
on your own machine. It tells you which tier a knowledge base reaches,
exactly which frontmatter fields each file is missing for the next
tier, whether a document can still be trusted, and what a git edit did
to that trust. It reads only: a scan writes nothing anywhere, and no
tool in this package makes a network call.

It is a clean-room rebuild of the `jidoseal-mcp` server's three local
tools. The original's two remaining tools are not rebuilt: one creates
a paid Stripe Checkout session (a payment funnel), and the other's
decisive output is a price that is published only on the vendor's
website, so it cannot be reproduced from the public record.

## What it checks

A field counts only if it has real content — `title:` with nothing
after it earns nothing.

| Tier | A file must have (populated) |
| --- | --- |
| **Bronze** | `type` |
| **Silver** | Bronze + `title`, `description`, `timestamp`, `owner` |
| **Gold** | Silver + `status`, `review_policy`, `reviewed_at`, `next_review_at` |

A corpus's tier is the tier of its **weakest file**. Coverage is the
share of files reaching each tier. Each missing field is marked `AUTO`
(a value the tool can propose) or `NEEDS-CLIENT` (only the owner can
answer). The 0–100 score is `round(mean of the three coverage
values)` — a reconstruction, disclosed as such: the original publishes
a worked value (44 for coverage 66.7 / 33.3 / 33.3) but no formula,
and this formula reproduces it. The Merkle root is the hex sha256 of
the concatenated per-file sha256 hex digests, files ordered by name —
also a disclosed reconstruction.

A note on egress: the original vendor claims its scan engine sends
nothing over the network. That is the vendor's own claim about its
proprietary engine, not independently audited. This rebuild is
simpler to reason about: it imports no HTTP client and opens no
socket, and `jidoseal_changes` starts exactly one program — the local
`git`, with transports disabled (`protocol.allow=never`,
`GIT_NO_LAZY_FETCH=1`).

One recorded deviation: the original also writes
`.jidoseal/manifest.json` and `.jidoseal/progress.ndjson` under the
scanned folder. This rebuild is read-only and writes nothing.

## Install

```bash
npx @reneturcios/sealtier jidoseal_scan '{"path":"/path/to/notes"}'
```

Or run the container image:

```bash
docker run -i ghcr.io/cloudcorprecords/sealtier
```

The container defaults to the MCP server (see below). Pass CLI
arguments to use it as a CLI instead.

## CLI

Each command takes its arguments as one JSON object and prints the
JSON result.

```bash
# Tier a folder of Markdown files
sealtier jidoseal_scan '{"path":"~/notes"}'

# Trust verdict for one file, or every *.md in a folder
sealtier jidoseal_trust '{"path":"~/notes/policies/leave.md"}'

# What changed since HEAD, and what it did to trust
sealtier jidoseal_changes '{"path":"~/notes"}'
sealtier jidoseal_changes '{"path":"~/notes","ref":"v1.2"}'

sealtier --version
```

Exit codes: `0` on success, `1` when a tool cannot complete (the
error names the problem — a missing folder, a failed `git status`),
`2` for usage errors.

## MCP server

One bin serves both faces. The `mcp` subcommand starts a stdio MCP
server:

```bash
npx -y @reneturcios/sealtier mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "sealtier": {
      "command": "npx",
      "args": ["-y", "@reneturcios/sealtier", "mcp"]
    }
  }
}
```

### Tools

| Tool | Input | What it returns |
| --- | --- | --- |
| `jidoseal_scan` | `path` (string, required) — folder of Markdown files | Corpus tier (its weakest file), per-file tier with `present` fields and per-tier `missing` lists, coverage per tier, a 0–100 score, per-file sha256 hashes, a Merkle root, an audit id, and the rubric. |
| `jidoseal_trust` | `path` (string, required) — one Markdown file, or a folder | Per file: verdict `stale` / `unverified` / `ok` with reasons, OKF conformance (a populated `type`), trust tier, `status`, whether it is stale, and `which_0_2` — which text of OKF v0.2 its timestamps follow (`2026-08-21` when `stale_after`, `sources[].last_modified`, or `usage_window` is a datetime with a UTC offset; both forms are accepted). |
| `jidoseal_changes` | `path` (string, required) — a git working tree; `ref` (string, optional, default `HEAD`) | Every `*.md` that differs from the ref: frontmatter changes, whether the body changed, and the trust effects — a verified document whose text changed while `verified` did not, `verified` or `type` removed, `generated.at` not updated, `status` or `stale_after` changed. |

Frontmatter parsing is a small hand-rolled YAML subset (flat
`key: value` pairs, quoted strings, inline lists/maps, one level of
indented block maps and lists). A frontmatter block outside that
subset is reported per file as `frontmatter_ok: false`; such a file
reaches no tier and no field counts until it is fixed by hand.

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm test        # node test runner over test/*.test.ts, no network, fake git executor
npm run dev     # run the CLI from source via tsx
```

## License

MIT — see `LICENSE`.
