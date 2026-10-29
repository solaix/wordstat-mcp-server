import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const API_BASE = "https://searchapi.api.cloud.yandex.net/v2/wordstat";
const DEFAULT_OUTPUT = "contract-results";
const REDACTED = "<redacted>";
const MAX_RESPONSE_BODY = 1_048_576;

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ProbeCase {
  name: string;
  description: string;
  endpoint: string;
  body: Record<string, JsonValue>;
  billable: boolean;
  expectedStatuses: number[];
}

interface CliOptions {
  confirmLive: boolean;
  listOnly: boolean;
  selectedCases: string[];
  outputDirectory: string;
}

interface ProbeResult {
  case: string;
  description: string;
  endpoint: string;
  billable: boolean;
  expectedStatuses: number[];
  observedStatus: number;
  matchedExpectedStatus: boolean;
  durationMs: number;
  request: JsonValue;
  response: JsonValue;
}

export function probeRunFailed(
  plannedCalls: number,
  completedCalls: number,
  transportFailureCount: number,
  unexpectedStatusCount: number,
): boolean {
  return completedCalls !== plannedCalls || transportFailureCount > 0 || unexpectedStatusCount > 0;
}

function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day));
}

function atUtcMidnight(date: Date): Date {
  return utcDate(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function addUtcDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function addUtcMonths(date: Date, months: number): Date {
  return utcDate(date.getUTCFullYear(), date.getUTCMonth() + months, 1);
}

function rfc3339(date: Date): string {
  return date.toISOString().replace(".000Z", "Z");
}

function dateRanges(now: Date): {
  daily: { fromDate: string; toDate: string };
  weekly: { fromDate: string; toDate: string };
  monthly: { fromDate: string; toDate: string };
} {
  const today = atUtcMidnight(now);
  const yesterday = addUtcDays(today, -1);
  const mondayOffset = (today.getUTCDay() + 6) % 7;
  const currentMonday = addUtcDays(today, -mondayOffset);
  const previousSunday = addUtcDays(currentMonday, -1);
  const firstOfCurrentMonth = utcDate(today.getUTCFullYear(), today.getUTCMonth(), 1);

  return {
    daily: {
      fromDate: rfc3339(addUtcDays(yesterday, -6)),
      toDate: rfc3339(yesterday),
    },
    weekly: {
      fromDate: rfc3339(addUtcDays(currentMonday, -28)),
      toDate: rfc3339(previousSunday),
    },
    monthly: {
      fromDate: rfc3339(addUtcMonths(firstOfCurrentMonth, -3)),
      toDate: rfc3339(addUtcDays(firstOfCurrentMonth, -1)),
    },
  };
}

function withFolderId(
  body: Record<string, JsonValue>,
  folderId: string | undefined,
): Record<string, JsonValue> {
  return folderId ? { ...body, folderId } : body;
}

export function buildProbeCases(now: Date, phrase: string, folderId?: string): ProbeCase[] {
  const ranges = dateRanges(now);
  const dynamicsBase = { phrase, devices: ["DEVICE_ALL"] } satisfies Record<string, JsonValue>;

  return [
    {
      name: "regions-tree",
      description: "GetRegionsTree response shape and region ID types",
      endpoint: "/getRegionsTree",
      body: withFolderId({}, folderId),
      billable: false,
      expectedStatuses: [200],
    },
    {
      name: "top-num-string",
      description: "GetTop documented protobuf JSON int64 representation",
      endpoint: "/topRequests",
      body: withFolderId({ phrase, numPhrases: "3", devices: ["DEVICE_ALL"] }, folderId),
      billable: true,
      expectedStatuses: [200],
    },
    {
      name: "top-num-number",
      description: "Whether GetTop also accepts numPhrases as a JSON number",
      endpoint: "/topRequests",
      body: withFolderId({ phrase, numPhrases: 3, devices: ["DEVICE_ALL"] }, folderId),
      billable: true,
      expectedStatuses: [200, 400],
    },
    {
      name: "regions",
      description: "GetRegionsDistribution share and affinityIndex runtime types",
      endpoint: "/regions",
      body: withFolderId({ phrase, region: "REGION_ALL", devices: ["DEVICE_ALL"] }, folderId),
      billable: true,
      expectedStatuses: [200],
    },
    {
      name: "dynamics-daily",
      description: "Daily dates and runtime types",
      endpoint: "/dynamics",
      body: withFolderId({ ...dynamicsBase, period: "PERIOD_DAILY", ...ranges.daily }, folderId),
      billable: true,
      expectedStatuses: [200],
    },
    {
      name: "dynamics-weekly",
      description: "Monday-to-Sunday weekly boundaries",
      endpoint: "/dynamics",
      body: withFolderId({ ...dynamicsBase, period: "PERIOD_WEEKLY", ...ranges.weekly }, folderId),
      billable: true,
      expectedStatuses: [200],
    },
    {
      name: "dynamics-monthly",
      description: "Three complete calendar months",
      endpoint: "/dynamics",
      body: withFolderId(
        { ...dynamicsBase, period: "PERIOD_MONTHLY", ...ranges.monthly },
        folderId,
      ),
      billable: true,
      expectedStatuses: [200],
    },
    {
      name: "dynamics-without-to-date",
      description: "Documented optional toDate behavior",
      endpoint: "/dynamics",
      body: withFolderId(
        {
          ...dynamicsBase,
          period: "PERIOD_DAILY",
          fromDate: ranges.daily.fromDate,
        },
        folderId,
      ),
      billable: true,
      expectedStatuses: [200],
    },
    {
      name: "dynamics-weekly-minus-operator",
      description: "Whether weekly silently accepts an unsupported minus operator",
      endpoint: "/dynamics",
      body: withFolderId(
        {
          ...dynamicsBase,
          phrase: `${phrase} -ремонт`,
          period: "PERIOD_WEEKLY",
          ...ranges.weekly,
        },
        folderId,
      ),
      billable: true,
      expectedStatuses: [200],
    },
  ];
}

export function sanitize(value: JsonValue, key = "", secrets: string[] = []): JsonValue {
  const sensitiveKeys = new Set([
    "phrase",
    "label",
    "folderId",
    "message",
    "description",
    "details",
    "nonJsonBody",
  ]);
  if (sensitiveKeys.has(key) && typeof value === "string") {
    return REDACTED;
  }
  if (typeof value === "string") {
    return secrets
      .filter((secret) => secret.length > 0)
      .reduce((text, secret) => text.replaceAll(secret, REDACTED), value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, "", secrets));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitize(childValue, childKey, secrets),
      ]),
    );
  }
  return value;
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    confirmLive: false,
    listOnly: false,
    selectedCases: [],
    outputDirectory: DEFAULT_OUTPUT,
  };

  for (const argument of args) {
    if (argument === "--confirm-live") options.confirmLive = true;
    else if (argument === "--list") options.listOnly = true;
    else if (argument.startsWith("--case=")) {
      const name = argument.slice("--case=".length).trim();
      if (!name) throw new Error("--case requires a non-empty name");
      options.selectedCases.push(name);
    } else if (argument.startsWith("--output=")) {
      const output = argument.slice("--output=".length).trim();
      if (!output) throw new Error("--output requires a directory");
      options.outputDirectory = output;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function readCredential(): { authorization: string; kind: "api-key" | "iam-token" } {
  const apiKey = process.env.YANDEX_WORDSTAT_API_KEY?.trim();
  const iamToken = process.env.YANDEX_WORDSTAT_IAM_TOKEN?.trim();
  if (Boolean(apiKey) === Boolean(iamToken)) {
    throw new Error("Set exactly one of YANDEX_WORDSTAT_API_KEY or YANDEX_WORDSTAT_IAM_TOKEN");
  }
  return apiKey
    ? { authorization: `Api-Key ${apiKey}`, kind: "api-key" }
    : { authorization: `Bearer ${iamToken}`, kind: "iam-token" };
}

export async function parseProbeResponse(response: Response): Promise<JsonValue> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BODY) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Probe response exceeds the size limit");
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BODY) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Probe response exceeds the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text) return null;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return { nonJsonBody: text.slice(0, 4_000) };
  }
}

async function executeCase(probe: ProbeCase, authorization: string): Promise<ProbeResult> {
  const started = performance.now();
  const response = await fetch(`${API_BASE}${probe.endpoint}`, {
    method: "POST",
    headers: {
      "accept-encoding": "identity",
      authorization,
      "content-type": "application/json",
      "user-agent": "wordstat-mcp-server-contract-probe/0.0.0",
    },
    body: JSON.stringify(probe.body),
    signal: AbortSignal.timeout(30_000),
  });
  const responseBody = await parseProbeResponse(response);
  const requestPhrase = typeof probe.body.phrase === "string" ? probe.body.phrase : "";
  const requestFolderId = typeof probe.body.folderId === "string" ? probe.body.folderId : "";
  const credentialValue = authorization.replace(/^[^ ]+ /, "");
  const secrets = [requestPhrase, requestFolderId, credentialValue];

  return {
    case: probe.name,
    description: probe.description,
    endpoint: probe.endpoint,
    billable: probe.billable,
    expectedStatuses: probe.expectedStatuses,
    observedStatus: response.status,
    matchedExpectedStatus: probe.expectedStatuses.includes(response.status),
    durationMs: Math.round(performance.now() - started),
    request: sanitize(probe.body, "", secrets),
    response: sanitize(responseBody, "", secrets),
  };
}

function printPlan(cases: ProbeCase[]): void {
  const billable = cases.filter((item) => item.billable).length;
  console.log(
    `Contract probe plan: ${cases.length} HTTP calls (${billable} potentially billable).`,
  );
  for (const probe of cases) {
    console.log(
      `- ${probe.name}: ${probe.description}${probe.billable ? " [billable]" : " [free]"}`,
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const phrase = process.env.YANDEX_WORDSTAT_PROBE_PHRASE?.trim() || "велосипед";
  const folderId = process.env.YANDEX_WORDSTAT_FOLDER_ID?.trim() || undefined;
  const allCases = buildProbeCases(new Date(), phrase, folderId);
  const knownNames = new Set(allCases.map((item) => item.name));
  const unknownNames = options.selectedCases.filter((name) => !knownNames.has(name));
  if (unknownNames.length > 0) {
    throw new Error(`Unknown probe cases: ${unknownNames.join(", ")}`);
  }
  const selected =
    options.selectedCases.length === 0
      ? allCases
      : allCases.filter((item) => options.selectedCases.includes(item.name));

  printPlan(selected);
  if (options.listOnly || !options.confirmLive) {
    if (!options.listOnly) {
      console.log("Dry run only. Add --confirm-live to perform the listed external calls.");
    }
    return;
  }

  const credential = readCredential();
  const outputRoot = resolve(options.outputDirectory);
  const runId = new Date().toISOString().replaceAll(":", "-");
  const outputDirectory = resolve(outputRoot, runId);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const results: ProbeResult[] = [];
  const transportFailures: Array<{ case: string; error: string }> = [];

  console.log(`Starting live probes with ${credential.kind}; credentials will not be persisted.`);
  for (const probe of selected) {
    try {
      const result = await executeCase(probe, credential.authorization);
      results.push(result);
      await writeFile(
        resolve(outputDirectory, `${probe.name}.json`),
        `${JSON.stringify(result, null, 2)}\n`,
        { mode: 0o600 },
      );
      console.log(`${probe.name}: HTTP ${result.observedStatus}`);
    } catch (error) {
      const safeMessage = error instanceof Error ? error.name : "UnknownError";
      transportFailures.push({ case: probe.name, error: safeMessage });
      console.error(`${probe.name}: transport failure (${safeMessage})`);
    }
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    apiBase: API_BASE,
    credentialKind: credential.kind,
    folderIdProvided: Boolean(folderId),
    plannedCalls: selected.length,
    potentiallyBillableCalls: selected.filter((item) => item.billable).length,
    completedCalls: results.length,
    transportFailures,
    unexpectedStatuses: results
      .filter((item) => !item.matchedExpectedStatus)
      .map((item) => ({ case: item.case, status: item.observedStatus })),
  };
  await writeFile(
    resolve(outputDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );

  console.log(`Sanitized results: ${outputDirectory}`);

  if (
    probeRunFailed(
      selected.length,
      results.length,
      transportFailures.length,
      results.filter((item) => !item.matchedExpectedStatus).length,
    )
  ) {
    process.exitCode = 1;
  }
}

const isEntryPoint = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isEntryPoint) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown contract probe failure";
    console.error(message);
    process.exitCode = 1;
  });
}
