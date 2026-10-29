import { WordstatError } from "./errors.js";

const LOG_LEVELS = ["silent", "error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface WordstatConfig {
  authorization: string;
  credentialKind: "api-key" | "iam-token";
  folderId?: string;
  timeoutMs: number;
  maxRetries: number;
  maxRps: number;
  maxRph: number;
  maxConcurrency: number;
  regionsCacheTtlMs: number;
  logLevel: LogLevel;
}

interface IntegerOptions {
  defaultValue: number;
  min: number;
  max: number;
}

function optionalTrimmed(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function readInteger(env: NodeJS.ProcessEnv, key: string, options: IntegerOptions): number {
  const raw = optionalTrimmed(env, key);
  if (raw === undefined) return options.defaultValue;
  if (!/^\d+$/.test(raw)) {
    throw new WordstatError("CONFIGURATION_ERROR", `${key} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < options.min || value > options.max) {
    throw new WordstatError(
      "CONFIGURATION_ERROR",
      `${key} must be between ${options.min} and ${options.max}`,
    );
  }
  return value;
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

function readLogLevel(env: NodeJS.ProcessEnv): LogLevel {
  const value = optionalTrimmed(env, "YANDEX_WORDSTAT_LOG_LEVEL") ?? "error";
  if (!isLogLevel(value)) {
    throw new WordstatError(
      "CONFIGURATION_ERROR",
      "YANDEX_WORDSTAT_LOG_LEVEL must be one of silent, error, warn, info or debug",
    );
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WordstatConfig {
  const apiKey = optionalTrimmed(env, "YANDEX_WORDSTAT_API_KEY");
  const iamToken = optionalTrimmed(env, "YANDEX_WORDSTAT_IAM_TOKEN");

  if (Boolean(apiKey) === Boolean(iamToken)) {
    throw new WordstatError(
      "CONFIGURATION_ERROR",
      "Set exactly one of YANDEX_WORDSTAT_API_KEY or YANDEX_WORDSTAT_IAM_TOKEN",
    );
  }

  const folderId = optionalTrimmed(env, "YANDEX_WORDSTAT_FOLDER_ID");
  if (folderId && folderId.length > 50) {
    throw new WordstatError(
      "CONFIGURATION_ERROR",
      "YANDEX_WORDSTAT_FOLDER_ID must not exceed 50 characters",
    );
  }

  return {
    authorization: apiKey ? `Api-Key ${apiKey}` : `Bearer ${iamToken}`,
    credentialKind: apiKey ? "api-key" : "iam-token",
    ...(folderId ? { folderId } : {}),
    timeoutMs: readInteger(env, "YANDEX_WORDSTAT_TIMEOUT_MS", {
      defaultValue: 30_000,
      min: 1,
      max: 300_000,
    }),
    maxRetries: readInteger(env, "YANDEX_WORDSTAT_MAX_RETRIES", {
      defaultValue: 2,
      min: 0,
      max: 10,
    }),
    maxRps: readInteger(env, "YANDEX_WORDSTAT_MAX_RPS", {
      defaultValue: 8,
      min: 1,
      max: 10_000,
    }),
    maxRph: readInteger(env, "YANDEX_WORDSTAT_MAX_RPH", {
      defaultValue: 100,
      min: 0,
      max: 1_000_000,
    }),
    maxConcurrency: readInteger(env, "YANDEX_WORDSTAT_MAX_CONCURRENCY", {
      defaultValue: 4,
      min: 1,
      max: 100,
    }),
    regionsCacheTtlMs: readInteger(env, "YANDEX_WORDSTAT_REGIONS_CACHE_TTL_MS", {
      defaultValue: 86_400_000,
      min: 0,
      max: 2_592_000_000,
    }),
    logLevel: readLogLevel(env),
  };
}
