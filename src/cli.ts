#!/usr/bin/env node
/**
 * sealtier CLI.
 *
 *   sealtier jidoseal_scan '<json>'      e.g. '{"path":"/path/to/folder"}'
 *   sealtier jidoseal_trust '<json>'     e.g. '{"path":"/path/to/file-or-folder"}'
 *   sealtier jidoseal_changes '<json>'   e.g. '{"path":"/path/to/tree","ref":"HEAD"}'
 *   sealtier mcp
 *   sealtier --version
 *
 * Each tool command takes its arguments as one JSON object and prints
 * the JSON result. Exit codes: 0 success, 1 tool/lookup error,
 * 2 usage error. Everything is local and read-only.
 */
import { changes, scan, trust, VERSION } from "./core.js";

function usage(): never {
  console.error(`Usage:
  sealtier jidoseal_scan '<json>'
  sealtier jidoseal_trust '<json>'
  sealtier jidoseal_changes '<json>'
  sealtier mcp
  sealtier --version`);
  process.exit(2);
}

const TOOL_COMMANDS = new Set(["jidoseal_scan", "jidoseal_trust", "jidoseal_changes"]);

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (cmd === "mcp") {
    await import("./mcp.js");
    return;
  }
  if (!cmd || !TOOL_COMMANDS.has(cmd)) usage();
  const [jsonArg] = rest;
  if (!jsonArg) usage();
  let args: unknown;
  try {
    args = JSON.parse(jsonArg);
  } catch {
    console.error(`error: arguments must be a JSON object, got: ${jsonArg}`);
    process.exit(2);
  }
  try {
    const result =
      cmd === "jidoseal_scan" ? scan(args) : cmd === "jidoseal_trust" ? trust(args) : changes(args);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
