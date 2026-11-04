# Changelog

## 0.1.0 (2026-10-27)

- Initial release. Clean-room rebuild of the local tools of
  `jidoseal-mcp` (OKF v0.2 tier checking for Markdown folders).
- CLI: `sealtier jidoseal_scan '<json>'`, `sealtier jidoseal_trust
  '<json>'`, and `sealtier jidoseal_changes '<json>'` — each takes a
  JSON argument object and prints the JSON result. `sealtier
  --version` prints the version.
- MCP server (`sealtier mcp`, stdio) with three tools:
  `jidoseal_scan`, `jidoseal_trust`, and `jidoseal_changes`. The
  original's `jidoseal_start_checkout` (paid Stripe Checkout) and
  `jidoseal_certification_offer` (pricing published only on the
  vendor's site) are omitted — see BUILD-REPORT.md.
- Scan: Bronze/Silver/Gold frontmatter tiers, per-file missing-field
  lists with `AUTO` / `NEEDS-CLIENT` fix marks, corpus coverage,
  score, per-file sha256 hashes, Merkle root, and audit id. Read-only
  (the original's `.jidoseal/` writes are a recorded deviation).
- Trust: `stale` / `unverified` / `ok` verdicts with reasons, trust
  tier, OKF conformance, and `which_0_2` timestamp-text detection.
- Changes: git comparison against a ref (default `HEAD`) through an
  injectable executor, git invoked with transports disabled;
  frontmatter/body diffs and trust effects per changed file.
