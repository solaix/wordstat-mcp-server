import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { WordstatClient, type CallMetadata, type DeviceWire } from "./client.js";
import { loadConfig, type WordstatConfig } from "./config.js";
import { assertSupportedDynamicsOperators, resolveDates } from "./dates.js";
import { safeErrorMessage, WordstatError } from "./errors.js";
import type { RegionNode } from "./wire.js";

export type WordstatApiClient = Pick<
  WordstatClient,
  "top" | "dynamics" | "regions" | "regionsTree" | "hourlyBudgetRemaining"
>;

export interface ToolRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  createClient?: (config: WordstatConfig) => WordstatApiClient;
  now?: () => number;
}

const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const deviceSchema = z.enum(["all", "desktop", "phone", "tablet"]);
const devicesSchema = z
  .array(deviceSchema)
  .max(3)
  .refine((items) => new Set(items).size === items.length, "Device values must be unique")
  .refine((items) => !items.includes("all") || items.length === 1, "all must be used alone")
  .optional();
const phraseSchema = z
  .string()
  .min(1)
  .max(400)
  .refine((value) => value.trim().length > 0, "Phrase must not contain only whitespace");
const regionIdsSchema = z.array(z.string().min(1)).max(100).optional();

const metadataSchema = z.object({
  api_calls: z.number().int().nonnegative(),
  http_attempts: z.number().int().nonnegative(),
  billable_calls_estimate: z.number().int().nonnegative(),
  local_hourly_budget_remaining: z.number().int().nonnegative().nullable(),
});
const baseFields = {
  content_truncated: z.boolean(),
  metadata: metadataSchema,
};
const countItemSchema = z.object({ phrase: z.string(), count: z.string() });
const publicRegionNodeSchema: z.ZodType<RegionNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    label: z.string(),
    children: z.array(publicRegionNodeSchema),
  }),
);

function deviceWire(devices: NonNullable<z.output<typeof devicesSchema>>): DeviceWire[] {
  const mapping: Record<z.output<typeof deviceSchema>, DeviceWire> = {
    all: "DEVICE_ALL",
    desktop: "DEVICE_DESKTOP",
    phone: "DEVICE_PHONE",
    tablet: "DEVICE_TABLET",
  };
  return devices.map((device) => mapping[device]);
}

function publicMetadata(metadata: CallMetadata): z.output<typeof metadataSchema> {
  return {
    api_calls: metadata.apiCalls,
    http_attempts: metadata.httpAttempts,
    billable_calls_estimate: metadata.billableCallsEstimate,
    local_hourly_budget_remaining: metadata.localHourlyBudgetRemaining,
  };
}

function mergeMetadata(...items: CallMetadata[]): CallMetadata {
  const last = items.at(-1);
  return {
    apiCalls: items.reduce((sum, item) => sum + item.apiCalls, 0),
    httpAttempts: items.reduce((sum, item) => sum + item.httpAttempts, 0),
    billableCallsEstimate: items.reduce((sum, item) => sum + item.billableCallsEstimate, 0),
    localHourlyBudgetRemaining: last?.localHourlyBudgetRemaining ?? null,
  };
}

function toolResult(output: Record<string, unknown>, summary: string): CallToolResult {
  let structuredContent = { ...output, content_truncated: false };
  const serialized = JSON.stringify(structuredContent);
  if (serialized.length <= 8_000) {
    return { content: [{ type: "text", text: serialized }], structuredContent };
  }
  structuredContent = { ...output, content_truncated: true };
  return {
    content: [{ type: "text", text: summary.slice(0, 8_000) }],
    structuredContent,
  };
}

function errorResult(error: unknown): CallToolResult {
  const known = error instanceof WordstatError ? error : undefined;
  const body = {
    code: known?.code ?? "INTERNAL_ERROR",
    message: safeErrorMessage(error),
    retryable: known?.retryable ?? false,
    ...(known?.status === undefined ? {} : { http_status: known.status }),
    ...(known?.retryAfterSeconds === undefined
      ? {}
      : { retry_after_seconds: known.retryAfterSeconds }),
    ...(known?.httpAttempts === undefined ? {} : { http_attempts: known.httpAttempts }),
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: { error: body },
  };
}

function waitForShared<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new WordstatError("CANCELLED", "The request was cancelled"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(new WordstatError("CANCELLED", "The request was cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("Unknown shared cache failure"));
      },
    );
  });
}

async function safely(operation: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await operation();
  } catch (error) {
    return errorResult(error);
  }
}

function compareInt64Descending(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left === right ? 0 : left > right ? -1 : 1;
}

function countNodes(nodes: RegionNode[]): number {
  return nodes.reduce((count, node) => count + 1 + countNodes(node.children), 0);
}

function treeDepth(nodes: RegionNode[], depth = 0): number {
  if (nodes.length === 0) return depth;
  return Math.max(...nodes.map((node) => treeDepth(node.children, depth + 1)));
}

function findNode(nodes: RegionNode[], id: string): RegionNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const nested = findNode(node.children, id);
    if (nested) return nested;
  }
  return undefined;
}

function findNodeContext(
  nodes: RegionNode[],
  id: string,
  path: string[] = [],
  parentId: string | null = null,
): { node: RegionNode; path: string[]; parentId: string | null } | undefined {
  for (const node of nodes) {
    const currentPath = [...path, node.label];
    if (node.id === id) return { node, path: currentPath, parentId };
    const nested = findNodeContext(node.children, id, currentPath, node.id);
    if (nested) return nested;
  }
  return undefined;
}

function pruneTree(nodes: RegionNode[], maxDepth: number, depth = 1): RegionNode[] {
  return nodes.map((node) => ({
    id: node.id,
    label: node.label,
    children: depth >= maxDepth ? [] : pruneTree(node.children, maxDepth, depth + 1),
  }));
}

function regionNameMap(nodes: RegionNode[], map = new Map<string, string>()): Map<string, string> {
  for (const node of nodes) {
    map.set(node.id, node.label);
    regionNameMap(node.children, map);
  }
  return map;
}

interface RegionMatch {
  region_id: string;
  label: string;
  path: string[];
  parent_id: string | null;
  match_type: "exact" | "case_insensitive" | "partial";
  node: RegionNode;
}

function searchRegions(
  nodes: RegionNode[],
  query: string,
  path: string[] = [],
  parentId: string | null = null,
): RegionMatch[] {
  const results: RegionMatch[] = [];
  const foldedQuery = query.toLocaleLowerCase("ru");
  for (const node of nodes) {
    const foldedLabel = node.label.toLocaleLowerCase("ru");
    const matchType =
      node.label === query
        ? "exact"
        : foldedLabel === foldedQuery
          ? "case_insensitive"
          : foldedLabel.includes(foldedQuery)
            ? "partial"
            : undefined;
    const currentPath = [...path, node.label];
    if (matchType) {
      results.push({
        region_id: node.id,
        label: node.label,
        path: currentPath,
        parent_id: parentId,
        match_type: matchType,
        node,
      });
    }
    results.push(...searchRegions(node.children, query, currentPath, node.id));
  }
  return results;
}

export function registerTools(server: McpServer, options: ToolRuntimeOptions = {}): void {
  let config: WordstatConfig | undefined;
  let client: WordstatApiClient | undefined;
  let cachedTree: { regions: RegionNode[]; loadedAt: number } | undefined;
  let treeInFlight:
    | {
        promise: Promise<{
          regions: RegionNode[];
          metadata: CallMetadata;
          cacheStatus: "miss" | "refreshed" | "stale";
        }>;
        controller: AbortController;
        consumers: number;
        settled: boolean;
      }
    | undefined;
  let lastRefreshFailure = 0;
  const now = options.now ?? Date.now;

  const getClient = (): { config: WordstatConfig; client: WordstatApiClient } => {
    if (!config || !client) {
      config = loadConfig(options.env ?? process.env);
      client = options.createClient?.(config) ?? new WordstatClient(config);
    }
    return { config, client };
  };

  const getTree = async (
    signal: AbortSignal,
  ): Promise<{
    regions: RegionNode[];
    metadata: CallMetadata;
    cacheStatus: "miss" | "hit" | "refreshed" | "stale";
  }> => {
    const runtime = getClient();
    const currentTime = now();
    if (cachedTree && currentTime - cachedTree.loadedAt < runtime.config.regionsCacheTtlMs) {
      return {
        regions: cachedTree.regions,
        metadata: {
          apiCalls: 0,
          httpAttempts: 0,
          billableCallsEstimate: 0,
          localHourlyBudgetRemaining: runtime.client.hourlyBudgetRemaining(),
        },
        cacheStatus: "hit",
      };
    }
    if (cachedTree && currentTime - lastRefreshFailure < 60_000) {
      return {
        regions: cachedTree.regions,
        metadata: {
          apiCalls: 0,
          httpAttempts: 0,
          billableCallsEstimate: 0,
          localHourlyBudgetRemaining: runtime.client.hourlyBudgetRemaining(),
        },
        cacheStatus: "stale",
      };
    }
    if (treeInFlight?.controller.signal.aborted) treeInFlight = undefined;
    if (!treeInFlight) {
      const hadCache = Boolean(cachedTree);
      const controller = new AbortController();
      const entry = {
        promise: runtime.client
          .regionsTree(controller.signal)
          .then((result) => {
            cachedTree = {
              regions: result.data.regions,
              loadedAt: now(),
            };
            return {
              regions: result.data.regions,
              metadata: result.metadata,
              cacheStatus: hadCache ? ("refreshed" as const) : ("miss" as const),
            };
          })
          .catch((error: unknown) => {
            if (error instanceof WordstatError && error.code === "CANCELLED") throw error;
            lastRefreshFailure = now();
            if (cachedTree) {
              return {
                regions: cachedTree.regions,
                metadata: {
                  apiCalls: 1,
                  httpAttempts: error instanceof WordstatError ? (error.httpAttempts ?? 0) : 0,
                  billableCallsEstimate: 0,
                  localHourlyBudgetRemaining: runtime.client.hourlyBudgetRemaining(),
                },
                cacheStatus: "stale" as const,
              };
            }
            throw error;
          }),
        controller,
        consumers: 0,
        settled: false,
      };
      treeInFlight = entry;
      const cleanup = (): void => {
        entry.settled = true;
        if (treeInFlight === entry) treeInFlight = undefined;
      };
      entry.promise.then(cleanup, cleanup);
    }
    const entry = treeInFlight;
    entry.consumers += 1;
    try {
      return await waitForShared(entry.promise, signal);
    } finally {
      entry.consumers -= 1;
      if (entry.consumers === 0 && !entry.settled) {
        if (treeInFlight === entry) treeInFlight = undefined;
        entry.controller.abort();
      }
    }
  };

  server.registerTool(
    "wordstat_top_requests",
    {
      title: "Wordstat top requests",
      description: "Popular and associated Wordstat queries for the last 30 days.",
      inputSchema: z.object({
        phrase: phraseSchema,
        num_phrases: z.number().int().min(1).max(2_000).default(50),
        region_ids: regionIdsSchema,
        devices: devicesSchema,
      }),
      outputSchema: z.object({
        total_count: z.string(),
        results: z.array(countItemSchema),
        associations: z.array(countItemSchema),
        associations_limit: z.literal(20),
        associations_possibly_truncated: z.boolean(),
        possibly_truncated: z.boolean(),
        returned: z.number().int(),
        applied_filters: z.object({
          region_ids: z.array(z.string()).optional(),
          devices: z.array(deviceSchema).optional(),
        }),
        ...baseFields,
      }),
      annotations: TOOL_ANNOTATIONS,
    },
    (input, context) =>
      safely(async () => {
        const result = await getClient().client.top(
          {
            phrase: input.phrase,
            numPhrases: input.num_phrases,
            ...(input.region_ids ? { regions: input.region_ids } : {}),
            ...(input.devices ? { devices: deviceWire(input.devices) } : {}),
          },
          context.mcpReq.signal,
        );
        const output = {
          total_count: result.data.totalCount,
          results: result.data.results,
          associations: result.data.associations,
          associations_limit: 20 as const,
          associations_possibly_truncated: result.data.associations.length === 20,
          possibly_truncated: result.data.results.length === input.num_phrases,
          returned: result.data.results.length,
          applied_filters: {
            ...(input.region_ids ? { region_ids: input.region_ids } : {}),
            ...(input.devices ? { devices: input.devices } : {}),
          },
          metadata: publicMetadata(result.metadata),
        };
        return toolResult(output, `Wordstat returned ${output.returned} top requests.`);
      }),
  );

  server.registerTool(
    "wordstat_dynamics",
    {
      title: "Wordstat dynamics",
      description: "Daily, weekly or monthly Wordstat demand dynamics.",
      inputSchema: z.object({
        phrase: phraseSchema,
        period: z.enum(["daily", "weekly", "monthly"]).default("monthly"),
        from_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        to_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        auto_dates: z.boolean().default(true),
        region_ids: regionIdsSchema,
        devices: devicesSchema,
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({ date: z.string(), count: z.string(), share: z.number().finite() }),
        ),
        requested_range: z.object({ from_date: z.string(), to_date: z.string().optional() }),
        returned_range: z.object({ from_date: z.string(), to_date: z.string() }).nullable(),
        period: z.enum(["daily", "weekly", "monthly"]),
        date_source: z.enum(["explicit", "auto", "mixed"]),
        current_period_excluded: z.boolean(),
        returned: z.number().int(),
        applied_filters: z.object({
          region_ids: z.array(z.string()).optional(),
          devices: z.array(deviceSchema).optional(),
        }),
        ...baseFields,
      }),
      annotations: TOOL_ANNOTATIONS,
    },
    (input, context) =>
      safely(async () => {
        const period = input.period;
        assertSupportedDynamicsOperators(input.phrase, period);
        const dates = resolveDates({
          period,
          ...(input.from_date ? { fromDate: input.from_date } : {}),
          ...(input.to_date ? { toDate: input.to_date } : {}),
          autoDates: input.auto_dates,
        });
        const periodWire = {
          daily: "PERIOD_DAILY",
          weekly: "PERIOD_WEEKLY",
          monthly: "PERIOD_MONTHLY",
        } as const;
        const result = await getClient().client.dynamics(
          {
            phrase: input.phrase,
            period: periodWire[period],
            fromDate: dates.fromDate,
            ...(dates.toDate ? { toDate: dates.toDate } : {}),
            ...(input.region_ids ? { regions: input.region_ids } : {}),
            ...(input.devices ? { devices: deviceWire(input.devices) } : {}),
          },
          context.mcpReq.signal,
        );
        const first = result.data.results[0]?.date;
        const last = result.data.results.at(-1)?.date;
        const output = {
          results: result.data.results,
          requested_range: {
            from_date: dates.fromDatePublic,
            ...(dates.toDatePublic ? { to_date: dates.toDatePublic } : {}),
          },
          returned_range: first && last ? { from_date: first, to_date: last } : null,
          period,
          date_source: dates.dateSource,
          current_period_excluded: dates.currentPeriodExcluded,
          returned: result.data.results.length,
          applied_filters: {
            ...(input.region_ids ? { region_ids: input.region_ids } : {}),
            ...(input.devices ? { devices: input.devices } : {}),
          },
          metadata: publicMetadata(result.metadata),
        };
        return toolResult(output, `Wordstat returned ${output.returned} ${period} data points.`);
      }),
  );

  server.registerTool(
    "wordstat_regions",
    {
      title: "Wordstat regions",
      description: "Wordstat demand distribution by region for the last 30 days.",
      inputSchema: z.object({
        phrase: phraseSchema,
        region_type: z.enum(["all", "cities", "regions"]).default("all"),
        devices: devicesSchema,
        limit: z.number().int().min(1).max(500).default(50),
        offset: z.number().int().nonnegative().default(0),
        resolve_names: z.boolean().default(true),
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({
            region_id: z.string(),
            region_name: z.string().nullable(),
            count: z.string(),
            share: z.number().finite(),
            affinity_index: z.number().finite(),
          }),
        ),
        total_available: z.number().int(),
        returned: z.number().int(),
        offset: z.number().int(),
        limit: z.number().int(),
        truncated: z.boolean(),
        region_names_resolved: z.boolean(),
        cache_status: z.enum(["not_used", "miss", "hit", "refreshed", "stale", "failed"]),
        region_name_resolution_error: z
          .object({ code: z.string(), message: z.string() })
          .optional(),
        ...baseFields,
      }),
      annotations: TOOL_ANNOTATIONS,
    },
    (input, context) =>
      safely(async () => {
        const regionWire = {
          all: "REGION_ALL",
          cities: "REGION_CITIES",
          regions: "REGION_REGIONS",
        } as const;
        const result = await getClient().client.regions(
          {
            phrase: input.phrase,
            region: regionWire[input.region_type],
            ...(input.devices ? { devices: deviceWire(input.devices) } : {}),
          },
          context.mcpReq.signal,
        );
        let names = new Map<string, string>();
        let cacheStatus: "not_used" | "miss" | "hit" | "refreshed" | "stale" | "failed" =
          "not_used";
        let metadata = result.metadata;
        let regionNameResolutionError: { code: string; message: string } | undefined;
        if (input.resolve_names) {
          try {
            const tree = await getTree(context.mcpReq.signal);
            names = regionNameMap(tree.regions);
            cacheStatus = tree.cacheStatus;
            metadata = mergeMetadata(result.metadata, tree.metadata);
          } catch (error) {
            if (error instanceof WordstatError && error.code === "CANCELLED") throw error;
            cacheStatus = "failed";
            metadata = mergeMetadata(result.metadata, {
              apiCalls: 1,
              httpAttempts: error instanceof WordstatError ? (error.httpAttempts ?? 0) : 0,
              billableCallsEstimate: 0,
              localHourlyBudgetRemaining: getClient().client.hourlyBudgetRemaining(),
            });
            regionNameResolutionError = {
              code: error instanceof WordstatError ? error.code : "INTERNAL_ERROR",
              message: safeErrorMessage(error),
            };
          }
        }
        const sorted = [...result.data.results].sort((a, b) =>
          compareInt64Descending(a.count, b.count),
        );
        const page = sorted.slice(input.offset, input.offset + input.limit).map((item) => ({
          region_id: item.region,
          region_name: names.get(item.region) ?? null,
          count: item.count,
          share: item.share,
          affinity_index: item.affinityIndex,
        }));
        const output = {
          results: page,
          total_available: sorted.length,
          returned: page.length,
          offset: input.offset,
          limit: input.limit,
          truncated: input.offset + page.length < sorted.length,
          region_names_resolved:
            input.resolve_names &&
            regionNameResolutionError === undefined &&
            page.every((item) => item.region_name !== null),
          cache_status: cacheStatus,
          ...(regionNameResolutionError
            ? { region_name_resolution_error: regionNameResolutionError }
            : {}),
          metadata: publicMetadata(metadata),
        };
        return toolResult(output, `Wordstat returned ${page.length} of ${sorted.length} regions.`);
      }),
  );

  server.registerTool(
    "wordstat_regions_tree",
    {
      title: "Wordstat regions tree",
      description: "The hierarchy of regions supported by Wordstat.",
      inputSchema: z.object({
        max_depth: z.number().int().min(1).max(20).default(3),
        root_region_id: z.string().min(1).optional(),
      }),
      outputSchema: z.object({
        regions: z.array(publicRegionNodeSchema),
        total_nodes: z.number().int(),
        actual_depth: z.number().int(),
        returned_depth: z.number().int(),
        truncated: z.boolean(),
        cache_status: z.enum(["miss", "hit", "refreshed", "stale"]),
        ...baseFields,
      }),
      annotations: TOOL_ANNOTATIONS,
    },
    (input, context) =>
      safely(async () => {
        const tree = await getTree(context.mcpReq.signal);
        const source = input.root_region_id
          ? (() => {
              const node = findNode(tree.regions, input.root_region_id);
              if (!node) throw new WordstatError("VALIDATION_ERROR", "Unknown root_region_id");
              return [node];
            })()
          : tree.regions;
        const actualDepth = treeDepth(source);
        const output = {
          regions: pruneTree(source, input.max_depth),
          total_nodes: countNodes(source),
          actual_depth: actualDepth,
          returned_depth: Math.min(actualDepth, input.max_depth),
          truncated: actualDepth > input.max_depth,
          cache_status: tree.cacheStatus,
          metadata: publicMetadata(tree.metadata),
        };
        return toolResult(
          output,
          `Wordstat regions tree: ${output.total_nodes} nodes, depth ${actualDepth}.`,
        );
      }),
  );

  server.registerTool(
    "wordstat_find_regions",
    {
      title: "Find Wordstat regions",
      description: "Find Wordstat region IDs locally by exact or substring name match.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(200)
          .refine((value) => value.trim().length > 0, "Query must not contain only whitespace"),
        limit: z.number().int().min(1).max(100).default(20),
        parent_region_id: z.string().min(1).optional(),
        include_children: z.boolean().default(false),
        children_depth: z.number().int().min(1).max(5).default(1),
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({
            region_id: z.string(),
            label: z.string(),
            path: z.array(z.string()),
            parent_id: z.string().nullable(),
            match_type: z.enum(["exact", "case_insensitive", "partial"]),
            children: z.array(publicRegionNodeSchema).optional(),
          }),
        ),
        total_available: z.number().int(),
        returned: z.number().int(),
        truncated: z.boolean(),
        cache_status: z.enum(["miss", "hit", "refreshed", "stale"]),
        ...baseFields,
      }),
      annotations: TOOL_ANNOTATIONS,
    },
    (input, context) =>
      safely(async () => {
        const tree = await getTree(context.mcpReq.signal);
        const parentContext = input.parent_region_id
          ? findNodeContext(tree.regions, input.parent_region_id)
          : undefined;
        if (input.parent_region_id && !parentContext) {
          throw new WordstatError("VALIDATION_ERROR", "Unknown parent_region_id");
        }
        const source = parentContext ? parentContext.node.children : tree.regions;
        const all = searchRegions(
          source,
          input.query,
          parentContext?.path ?? [],
          parentContext?.node.id ?? null,
        ).sort((a, b) => {
          const rank = { exact: 0, case_insensitive: 1, partial: 2 } as const;
          return rank[a.match_type] - rank[b.match_type] || a.label.localeCompare(b.label, "ru");
        });
        const results = all.slice(0, input.limit).map(({ node, ...match }) => ({
          ...match,
          ...(input.include_children
            ? { children: pruneTree(node.children, input.children_depth) }
            : {}),
        }));
        const output = {
          results,
          total_available: all.length,
          returned: results.length,
          truncated: results.length < all.length,
          cache_status: tree.cacheStatus,
          metadata: publicMetadata(tree.metadata),
        };
        return toolResult(output, `Found ${results.length} of ${all.length} matching regions.`);
      }),
  );
}
