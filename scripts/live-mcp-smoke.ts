import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { buildServer } from "../src/server.js";

const CONFIRM_FLAG = "--confirm-live";

interface SmokeSummary {
  tool: string;
  ok: boolean;
  apiCalls?: number;
  httpAttempts?: number;
  billableCallsEstimate?: number;
  returned?: number;
  cacheStatus?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object MCP result");
  }
  return value as Record<string, unknown>;
}

function summarize(tool: string, output: Record<string, unknown>): SmokeSummary {
  const metadata = asRecord(output.metadata);
  return {
    tool,
    ok: true,
    apiCalls: Number(metadata.api_calls),
    httpAttempts: Number(metadata.http_attempts),
    billableCallsEstimate: Number(metadata.billable_calls_estimate),
    ...(typeof output.returned === "number" ? { returned: output.returned } : {}),
    ...(typeof output.cache_status === "string" ? { cacheStatus: output.cache_status } : {}),
  };
}

async function main(): Promise<void> {
  console.log(
    "MCP live smoke plan: 5 tool calls, 4 external API operations, 3 potentially billable.",
  );
  console.log(
    "No retries are forced; configured retry policy still applies to real transient failures.",
  );
  if (!process.argv.includes(CONFIRM_FLAG)) {
    console.log(`Dry run only. Add ${CONFIRM_FLAG} to execute.`);
    return;
  }

  const phrase = process.env.YANDEX_WORDSTAT_PROBE_PHRASE?.trim();
  if (!phrase) {
    throw new Error("YANDEX_WORDSTAT_PROBE_PHRASE must be set for live smoke");
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  const client = new Client({ name: "wordstat-live-smoke", version: "1.0.0" });
  const summaries: SmokeSummary[] = [];

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.listTools();

    const calls = [
      {
        name: "wordstat_top_requests",
        arguments: { phrase, num_phrases: 3 },
      },
      {
        name: "wordstat_dynamics",
        arguments: { phrase, period: "monthly", auto_dates: true },
      },
      {
        name: "wordstat_regions",
        arguments: { phrase, limit: 3, resolve_names: false },
      },
      {
        name: "wordstat_regions_tree",
        arguments: { max_depth: 1 },
      },
      {
        name: "wordstat_find_regions",
        arguments: { query: "Москва", limit: 3 },
      },
    ] as const;

    for (const call of calls) {
      const result = await client.callTool(call);
      if (result.isError) {
        const error = result.structuredContent
          ? JSON.stringify(result.structuredContent)
          : "structured error unavailable";
        throw new Error(`${call.name} failed: ${error}`);
      }
      summaries.push(summarize(call.name, asRecord(result.structuredContent)));
    }
  } finally {
    await client.close();
    await server.close();
  }

  for (const summary of summaries) console.log(JSON.stringify(summary));
  console.log("MCP live smoke completed successfully.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown live smoke failure";
  console.error(message);
  process.exitCode = 1;
});
