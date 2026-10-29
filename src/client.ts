import type { z } from "zod";

import type { WordstatConfig } from "./config.js";
import { withHttpAttempts, WordstatError } from "./errors.js";
import { delay, RequestLimiter } from "./rate-limiter.js";
import {
  dynamicsResponseSchema,
  regionsResponseSchema,
  regionsTreeResponseSchema,
  topResponseSchema,
  type DynamicsResponse,
  type RegionsResponse,
  type RegionsTreeResponse,
  type TopResponse,
} from "./wire.js";
import { VERSION } from "./version.js";

const API_BASE = "https://searchapi.api.cloud.yandex.net/v2/wordstat";
const MAX_ERROR_BODY = 8_000;
const MAX_SUCCESS_BODY = 10 * 1024 * 1024;
const LOG_LEVEL_PRIORITY = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 } as const;

export type DeviceWire = "DEVICE_ALL" | "DEVICE_DESKTOP" | "DEVICE_PHONE" | "DEVICE_TABLET";
export type PeriodWire = "PERIOD_DAILY" | "PERIOD_WEEKLY" | "PERIOD_MONTHLY";
export type RegionWire = "REGION_ALL" | "REGION_CITIES" | "REGION_REGIONS";

export interface CallMetadata {
  apiCalls: number;
  httpAttempts: number;
  billableCallsEstimate: number;
  localHourlyBudgetRemaining: number | null;
}

export interface ApiResult<T> {
  data: T;
  metadata: CallMetadata;
}

type Fetch = typeof globalThis.fetch;

interface InFlightRequest {
  promise: Promise<ApiResult<unknown>>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
}

function readWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  const abortError = (): Error => {
    const reason: unknown = signal.reason;
    return reason instanceof Error
      ? reason
      : new DOMException("The request was aborted", "AbortError");
  };
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("Unknown response stream failure"));
      },
    );
  });
}

async function readBodyLimited(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new WordstatError(
      "UPSTREAM_CONTRACT_ERROR",
      `Yandex Wordstat response exceeds the ${maxBytes}-byte limit`,
    );
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancelReader = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  try {
    for (;;) {
      const { done, value } = await readWithSignal(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new WordstatError(
          "UPSTREAM_CONTRACT_ERROR",
          `Yandex Wordstat response exceeds the ${maxBytes}-byte limit`,
        );
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancelReader);
    try {
      reader.releaseLock();
    } catch {
      // A pending read keeps the lock until cancellation settles.
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new WordstatError("UPSTREAM_CONTRACT_ERROR", "Yandex Wordstat returned invalid UTF-8", {
      cause: error,
    });
  }
}

function cancellationResult<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
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
        reject(error instanceof Error ? error : new Error("Unknown shared request failure"));
      },
    );
  });
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) {
    const seconds = Number(value.trim());
    return Number.isSafeInteger(seconds) ? seconds : undefined;
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1_000));
}

function classifyStatus(status: number, retryAfterSeconds?: number): WordstatError {
  if (status === 401) {
    return new WordstatError("AUTHENTICATION_ERROR", "Yandex rejected the configured credential", {
      status,
    });
  }
  if (status === 403) {
    return new WordstatError(
      "AUTHORIZATION_ERROR",
      "Access denied: verify folderId, yc.search-api.execute scope and search-api.webSearch.user role",
      { status },
    );
  }
  if (status === 429) {
    return new WordstatError("RATE_LIMITED", "Yandex Wordstat quota is exhausted", {
      status,
      retryable: true,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }
  if (status >= 500) {
    return new WordstatError("UPSTREAM_ERROR", `Yandex Wordstat returned HTTP ${status}`, {
      status,
      retryable: true,
    });
  }
  return new WordstatError(
    "VALIDATION_ERROR",
    `Yandex Wordstat rejected the request (HTTP ${status})`,
    {
      status,
    },
  );
}

export class WordstatClient {
  private readonly limiter: RequestLimiter;
  private readonly inFlight = new Map<string, InFlightRequest>();

  constructor(
    private readonly config: WordstatConfig,
    private readonly fetchImpl: Fetch = globalThis.fetch,
    private readonly random: () => number = Math.random,
  ) {
    this.limiter = new RequestLimiter(config.maxConcurrency, config.maxRps, config.maxRph);
  }

  private bodyWithFolder(body: Record<string, unknown>): Record<string, unknown> {
    return this.config.folderId ? { ...body, folderId: this.config.folderId } : body;
  }

  private log(
    level: Exclude<WordstatConfig["logLevel"], "silent">,
    event: string,
    fields: Record<string, string | number | boolean | undefined>,
  ): void {
    if (LOG_LEVEL_PRIORITY[this.config.logLevel] < LOG_LEVEL_PRIORITY[level]) return;
    const safeFields = Object.fromEntries(
      Object.entries(fields).filter((entry): entry is [string, string | number | boolean] => {
        return entry[1] !== undefined;
      }),
    );
    console.error(JSON.stringify({ source: "yandex-wordstat", level, event, ...safeFields }));
  }

  private async post<T>(
    endpoint: string,
    body: Record<string, unknown>,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    billable: boolean,
  ): Promise<ApiResult<T>> {
    const wireBody = this.bodyWithFolder(body);
    const dedupeKey = `${endpoint}:${JSON.stringify(wireBody)}`;
    let entry = this.inFlight.get(dedupeKey);
    if (entry?.controller.signal.aborted) {
      this.inFlight.delete(dedupeKey);
      entry = undefined;
    }
    if (!entry) {
      const controller = new AbortController();
      entry = {
        promise: this.performPost(endpoint, wireBody, schema, controller.signal, billable),
        controller,
        consumers: 0,
        settled: false,
      };
      this.inFlight.set(dedupeKey, entry);
      const cleanup = (): void => {
        entry!.settled = true;
        if (this.inFlight.get(dedupeKey) === entry) this.inFlight.delete(dedupeKey);
      };
      entry.promise.then(cleanup, cleanup);
    }

    entry.consumers += 1;
    try {
      return (await cancellationResult(entry.promise, signal)) as ApiResult<T>;
    } finally {
      entry.consumers -= 1;
      if (entry.consumers === 0 && !entry.settled) {
        if (this.inFlight.get(dedupeKey) === entry) this.inFlight.delete(dedupeKey);
        entry.controller.abort();
      }
    }
  }

  private async performPost<T>(
    endpoint: string,
    body: Record<string, unknown>,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    billable: boolean,
  ): Promise<ApiResult<T>> {
    let retries = 0;
    let httpAttempts = 0;
    let lastError: WordstatError | undefined;

    for (;;) {
      try {
        const data = await this.limiter.run(async () => {
          const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs);
          const requestSignal = AbortSignal.any([signal, timeoutSignal]);
          httpAttempts += 1;
          const startedAt = Date.now();
          this.log("debug", "http_attempt_started", { endpoint, attempt: httpAttempts });
          const response = await this.fetchImpl(`${API_BASE}${endpoint}`, {
            method: "POST",
            headers: {
              "accept-encoding": "identity",
              authorization: this.config.authorization,
              "content-type": "application/json",
              "user-agent": `wordstat-mcp-server/${VERSION}`,
            },
            body: JSON.stringify(body),
            signal: requestSignal,
          });
          this.log("info", "http_attempt_completed", {
            endpoint,
            attempt: httpAttempts,
            status: response.status,
            duration_ms: Date.now() - startedAt,
            request_id: response.headers.get("x-request-id")?.slice(0, 200),
          });
          if (!response.ok) {
            await readBodyLimited(response, MAX_ERROR_BODY, requestSignal).catch(() => "");
            throw classifyStatus(
              response.status,
              parseRetryAfter(response.headers.get("retry-after")),
            );
          }

          const text = await readBodyLimited(response, MAX_SUCCESS_BODY, requestSignal);
          let raw: unknown;
          try {
            raw = JSON.parse(text) as unknown;
          } catch (error) {
            throw new WordstatError(
              "UPSTREAM_CONTRACT_ERROR",
              "Yandex Wordstat returned invalid JSON",
              { cause: error },
            );
          }
          const parsed = schema.safeParse(raw);
          if (!parsed.success) {
            throw new WordstatError(
              "UPSTREAM_CONTRACT_ERROR",
              "Yandex Wordstat returned an unexpected response shape",
              { cause: parsed.error },
            );
          }
          return parsed.data;
        }, signal);
        return {
          data,
          metadata: {
            apiCalls: 1,
            httpAttempts,
            billableCallsEstimate: billable ? httpAttempts : 0,
            localHourlyBudgetRemaining: this.limiter.hourlyRemaining(),
          },
        };
      } catch (error) {
        if (signal.aborted) {
          throw new WordstatError("CANCELLED", "The request was cancelled", { httpAttempts });
        }
        if (error instanceof WordstatError) lastError = error;
        else if (error instanceof DOMException && error.name === "TimeoutError") {
          lastError = new WordstatError("TIMEOUT", "Yandex Wordstat request timed out", {
            retryable: true,
            cause: error,
          });
        } else {
          lastError = new WordstatError("NETWORK_ERROR", "Yandex Wordstat network request failed", {
            retryable: true,
            cause: error,
          });
        }

        if (!lastError.retryable || retries >= this.config.maxRetries) {
          this.log("error", "request_failed", {
            endpoint,
            code: lastError.code,
            status: lastError.status,
            http_attempts: httpAttempts,
          });
          throw withHttpAttempts(lastError, httpAttempts);
        }
        const retryAfterMs = (lastError.retryAfterSeconds ?? 0) * 1_000;
        if (retryAfterMs > 30_000) throw withHttpAttempts(lastError, httpAttempts);
        const exponentialCap = Math.min(30_000, 500 * 2 ** retries);
        const backoffMs = retryAfterMs || Math.floor(this.random() * exponentialCap);
        retries += 1;
        this.log("warn", "request_retry_scheduled", {
          endpoint,
          code: lastError.code,
          http_attempts: httpAttempts,
          backoff_ms: backoffMs,
        });
        await delay(backoffMs, signal);
      }
    }
  }

  top(
    input: { phrase: string; numPhrases: number; regions?: string[]; devices?: DeviceWire[] },
    signal: AbortSignal,
  ): Promise<ApiResult<TopResponse>> {
    return this.post(
      "/topRequests",
      { ...input, numPhrases: String(input.numPhrases) },
      topResponseSchema,
      signal,
      true,
    );
  }

  dynamics(
    input: {
      phrase: string;
      period: PeriodWire;
      fromDate: string;
      toDate?: string;
      regions?: string[];
      devices?: DeviceWire[];
    },
    signal: AbortSignal,
  ): Promise<ApiResult<DynamicsResponse>> {
    return this.post("/dynamics", input, dynamicsResponseSchema, signal, true);
  }

  regions(
    input: { phrase: string; region: RegionWire; devices?: DeviceWire[] },
    signal: AbortSignal,
  ): Promise<ApiResult<RegionsResponse>> {
    return this.post("/regions", input, regionsResponseSchema, signal, true);
  }

  regionsTree(signal: AbortSignal): Promise<ApiResult<RegionsTreeResponse>> {
    return this.post("/getRegionsTree", {}, regionsTreeResponseSchema, signal, false);
  }

  hourlyBudgetRemaining(): number | null {
    return this.limiter.hourlyRemaining();
  }
}
