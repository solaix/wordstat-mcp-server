import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { buildServer } from "../src/server.js";

test("MCP handshake and tools/list expose five validated atomic tools", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer({ env: {} });
  const client = new Client({ name: "wordstat-protocol-test", version: "1.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.listTools();
    assert.deepEqual(result.tools.map((tool) => tool.name).sort(), [
      "wordstat_dynamics",
      "wordstat_find_regions",
      "wordstat_regions",
      "wordstat_regions_tree",
      "wordstat_top_requests",
    ]);
    for (const tool of result.tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.outputSchema?.type, "object");
      assert.deepEqual(tool.annotations, {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
    }

    const failed = await client.callTool({
      name: "wordstat_top_requests",
      arguments: { phrase: "test" },
    });
    assert.equal(failed.isError, true);
    assert.deepEqual(failed.structuredContent, {
      error: {
        code: "CONFIGURATION_ERROR",
        message: "Set exactly one of YANDEX_WORDSTAT_API_KEY or YANDEX_WORDSTAT_IAM_TOKEN",
        retryable: false,
      },
    });
  } finally {
    await client.close();
    await server.close();
  }
});
