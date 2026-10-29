import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import type { ApiResult } from "../src/client.js";
import { WordstatError } from "../src/errors.js";
import { buildServer } from "../src/server.js";
import type { WordstatApiClient } from "../src/tools.js";
import type {
  DynamicsResponse,
  RegionsResponse,
  RegionsTreeResponse,
  TopResponse,
} from "../src/wire.js";

const metadata = {
  apiCalls: 1,
  httpAttempts: 1,
  billableCallsEstimate: 0,
  localHourlyBudgetRemaining: 99,
};

function unused<T>(): Promise<ApiResult<T>> {
  return Promise.reject(new Error("Unexpected fake API method"));
}

function fakeClient(overrides: Partial<WordstatApiClient>): WordstatApiClient {
  return {
    top: () => unused<TopResponse>(),
    dynamics: () => unused<DynamicsResponse>(),
    regions: () => unused<RegionsResponse>(),
    regionsTree: () => unused<RegionsTreeResponse>(),
    hourlyBudgetRemaining: () => 99,
    ...overrides,
  };
}

async function withClient<T>(
  api: WordstatApiClient,
  operation: (client: Client) => Promise<T>,
  options: { ttl?: number; now?: () => number } = {},
): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer({
    env: {
      YANDEX_WORDSTAT_API_KEY: "test-key",
      YANDEX_WORDSTAT_REGIONS_CACHE_TTL_MS: String(options.ttl ?? 86_400_000),
    },
    createClient: () => api,
    ...(options.now ? { now: options.now } : {}),
  });
  const client = new Client({ name: "tools-test", version: "1.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await operation(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.equal(result.isError, undefined);
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

test("regions tree cache reports miss, hit, stale fallback and refresh cooldown", async () => {
  let now = 100_000;
  let calls = 0;
  let fail = false;
  const api = fakeClient({
    async regionsTree() {
      calls += 1;
      if (fail) {
        throw new WordstatError("UPSTREAM_ERROR", "temporary", {
          retryable: true,
          httpAttempts: 2,
        });
      }
      return {
        data: {
          regions: [
            { id: "1", label: "Root", children: [{ id: "2", label: "Child", children: [] }] },
          ],
        },
        metadata,
      };
    },
  });

  await withClient(
    api,
    async (client) => {
      const first = structured(
        await client.callTool({ name: "wordstat_regions_tree", arguments: {} }),
      );
      assert.equal(first.cache_status, "miss");
      assert.equal((first.metadata as Record<string, unknown>).http_attempts, 1);

      const second = structured(
        await client.callTool({ name: "wordstat_regions_tree", arguments: {} }),
      );
      assert.equal(second.cache_status, "hit");
      assert.equal((second.metadata as Record<string, unknown>).http_attempts, 0);
      assert.equal((second.metadata as Record<string, unknown>).local_hourly_budget_remaining, 99);

      now += 1_001;
      fail = true;
      const stale = structured(
        await client.callTool({ name: "wordstat_regions_tree", arguments: {} }),
      );
      assert.equal(stale.cache_status, "stale");
      assert.equal((stale.metadata as Record<string, unknown>).http_attempts, 2);

      now += 10_000;
      const cooldown = structured(
        await client.callTool({ name: "wordstat_regions_tree", arguments: {} }),
      );
      assert.equal(cooldown.cache_status, "stale");
      assert.equal((cooldown.metadata as Record<string, unknown>).http_attempts, 0);
      assert.equal(calls, 2);
    },
    { ttl: 1_000, now: () => now },
  );
});

test("zero cache TTL reloads the region tree on every sequential call", async () => {
  let calls = 0;
  const api = fakeClient({
    async regionsTree() {
      calls += 1;
      return { data: { regions: [] }, metadata };
    },
  });
  await withClient(
    api,
    async (client) => {
      await client.callTool({ name: "wordstat_regions_tree", arguments: {} });
      await client.callTool({ name: "wordstat_regions_tree", arguments: {} });
    },
    { ttl: 0 },
  );
  assert.equal(calls, 2);
});

test("cancelled tree refresh does not activate stale-cache cooldown", async () => {
  let now = 100_000;
  let calls = 0;
  let refreshStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  const api = fakeClient({
    async regionsTree(signal) {
      calls += 1;
      if (calls === 2) {
        refreshStarted?.();
        return new Promise<ApiResult<RegionsTreeResponse>>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new WordstatError("CANCELLED", "The request was cancelled")),
            { once: true },
          );
        });
      }
      return {
        data: { regions: [{ id: "1", label: `Tree ${calls}`, children: [] }] },
        metadata,
      };
    },
  });

  await withClient(
    api,
    async (client) => {
      await client.callTool({ name: "wordstat_regions_tree", arguments: {} });
      now += 1_001;
      const controller = new AbortController();
      const refresh = client.callTool(
        { name: "wordstat_regions_tree", arguments: {} },
        { signal: controller.signal },
      );
      await started;
      controller.abort();
      await assert.rejects(refresh);
      await new Promise((resolve) => setImmediate(resolve));

      now += 10_000;
      const next = structured(
        await client.callTool({ name: "wordstat_regions_tree", arguments: {} }),
      );
      assert.equal(next.cache_status, "refreshed");
      assert.equal(calls, 3);
    },
    { ttl: 1_000, now: () => now },
  );
});

test("regions tool sorts int64 safely, paginates locally and resolves names", async () => {
  const api = fakeClient({
    async regions() {
      return {
        data: {
          results: [
            { region: "2", count: "9007199254740993", share: 0.2, affinityIndex: 1.2 },
            { region: "1", count: "10", share: 0.1, affinityIndex: 1.1 },
            { region: "3", count: "90071992547409930", share: 0.3, affinityIndex: 1.3 },
          ],
        },
        metadata: { ...metadata, billableCallsEstimate: 1 },
      };
    },
    async regionsTree() {
      return {
        data: {
          regions: [
            { id: "1", label: "One", children: [] },
            { id: "2", label: "Two", children: [] },
            { id: "3", label: "Three", children: [] },
          ],
        },
        metadata,
      };
    },
  });

  await withClient(api, async (client) => {
    const output = structured(
      await client.callTool({
        name: "wordstat_regions",
        arguments: { phrase: "test", offset: 1, limit: 1 },
      }),
    );
    const results = output.results as Array<Record<string, unknown>>;
    assert.deepEqual(results, [
      {
        region_id: "2",
        region_name: "Two",
        count: "9007199254740993",
        share: 0.2,
        affinity_index: 1.2,
      },
    ]);
    assert.equal(output.total_available, 3);
    assert.equal(output.truncated, true);
    assert.equal(output.cache_status, "miss");
    assert.deepEqual(output.metadata, {
      api_calls: 2,
      http_attempts: 2,
      billable_calls_estimate: 1,
      local_hourly_budget_remaining: 99,
    });
  });
});

test("regions tool preserves paid-call metadata when name resolution fails", async () => {
  const api = fakeClient({
    async regions() {
      return {
        data: {
          results: [{ region: "213", count: "10", share: 0.1, affinityIndex: 1.1 }],
        },
        metadata: { ...metadata, billableCallsEstimate: 1 },
      };
    },
    async regionsTree() {
      throw new WordstatError("UPSTREAM_ERROR", "tree unavailable", {
        retryable: true,
        httpAttempts: 2,
      });
    },
  });

  await withClient(api, async (client) => {
    const output = structured(
      await client.callTool({ name: "wordstat_regions", arguments: { phrase: "test" } }),
    );
    assert.equal(output.cache_status, "failed");
    assert.equal(output.region_names_resolved, false);
    assert.deepEqual(output.results, [
      {
        region_id: "213",
        region_name: null,
        count: "10",
        share: 0.1,
        affinity_index: 1.1,
      },
    ]);
    assert.deepEqual(output.region_name_resolution_error, {
      code: "UPSTREAM_ERROR",
      message: "tree unavailable",
    });
    assert.deepEqual(output.metadata, {
      api_calls: 2,
      http_attempts: 3,
      billable_calls_estimate: 1,
      local_hourly_budget_remaining: 99,
    });
  });
});

test("top tool keeps complete structured data and marks long text content truncated", async () => {
  const api = fakeClient({
    async top() {
      return {
        data: {
          totalCount: "100",
          results: Array.from({ length: 50 }, (_, index) => ({
            phrase: `phrase-${index}-${"x".repeat(200)}`,
            count: String(100 - index),
          })),
          associations: [],
        },
        metadata: { ...metadata, billableCallsEstimate: 1 },
      };
    },
  });

  await withClient(api, async (client) => {
    const result = await client.callTool({
      name: "wordstat_top_requests",
      arguments: { phrase: "test", num_phrases: 50 },
    });
    const output = structured(result);
    assert.equal((output.results as unknown[]).length, 50);
    assert.equal(output.content_truncated, true);
    assert.ok(JSON.stringify(result.content).length <= 8_100);
  });
});

test("find regions preserves the full path and direct parent inside a subtree", async () => {
  const api = fakeClient({
    async regionsTree() {
      return {
        data: {
          regions: [
            {
              id: "1",
              label: "Country",
              children: [
                {
                  id: "2",
                  label: "Area",
                  children: [{ id: "3", label: "City", children: [] }],
                },
              ],
            },
          ],
        },
        metadata,
      };
    },
  });
  await withClient(api, async (client) => {
    const output = structured(
      await client.callTool({
        name: "wordstat_find_regions",
        arguments: { query: "City", parent_region_id: "2" },
      }),
    );
    assert.deepEqual(output.results, [
      {
        region_id: "3",
        label: "City",
        path: ["Country", "Area", "City"],
        parent_id: "2",
        match_type: "exact",
      },
    ]);
  });
});
