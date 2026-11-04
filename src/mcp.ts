/**
 * sealtier MCP server. Tools: jidoseal_scan, jidoseal_trust,
 * jidoseal_changes (3 of the original's 5 — see BUILD-REPORT.md for the
 * two omissions and their reasons).
 *
 * Why the low-level Server instead of McpServer: the high-level helper
 * converts zod schemas to JSON Schema and injects two keys that are not
 * in this tool's public spec ("$schema" and "additionalProperties"),
 * which breaks exact tool-list/schema parity with the spec. This file
 * therefore serves tools/list with the spec's exact input schemas as
 * literals, while the core validates every tools/call argument set
 * itself. Tool names, descriptions, and schemas are taken verbatim from
 * harness/fixtures/jidoseal-tools-original.json.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { changes, scan, trust, VERSION } from "./core.js";

const TOOLS = [
  {
    name: "jidoseal_scan",
    description:
      "Scan a folder of Markdown files and report its OKF v0.2 frontmatter tier: corpus tier (its weakest file), per-file tier, present fields, and the exact fields missing for each unreached tier, plus coverage per tier, a 0-100 score and a Merkle root of the corpus. Local and read-only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Path to the folder of Markdown files to scan" },
      },
      required: ["path"],
    },
  },
  {
    name: "jidoseal_trust",
    description:
      "Check one Markdown file, or every Markdown file in a folder, before relying on it: verdict stale, unverified or ok with reasons, from its OKF v0.2 trust and lifecycle fields, plus its trust tier, OKF conformance and which text of v0.2 its timestamps follow. Reads only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Path to one Markdown file, or to a folder of Markdown files" },
      },
      required: ["path"],
    },
  },
  {
    name: "jidoseal_changes",
    description:
      "Report every Markdown file that differs from a git commit (default HEAD, so uncommitted edits and new files): what changed in its frontmatter and body, and what that did to its trust. Reads only; runs the local git with transports disabled.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Path to the folder (a git working tree) to inspect" },
        ref: { type: "string", description: "Git commit to compare against (default HEAD)" },
      },
      required: ["path"],
    },
  },
];

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(err: unknown) {
  return {
    content: [
      { type: "text" as const, text: err instanceof Error ? err.message : String(err) },
    ],
    isError: true,
  };
}

const server = new Server(
  { name: "sealtier", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    if (name === "jidoseal_scan") return textResult(scan(args ?? {}));
    if (name === "jidoseal_trust") return textResult(trust(args ?? {}));
    if (name === "jidoseal_changes") return textResult(changes(args ?? {}));
  } catch (err) {
    return errorResult(err);
  }
  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
