import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { WordstatError } from "../src/errors.js";

test("configuration accepts exactly one credential and applies defaults", () => {
  const config = loadConfig({ YANDEX_WORDSTAT_API_KEY: "test-key" });
  assert.equal(config.authorization, "Api-Key test-key");
  assert.equal(config.maxRps, 8);
  assert.equal(config.maxRph, 100);
  assert.equal(config.maxConcurrency, 4);
  assert.equal(config.logLevel, "error");
});

test("configuration validates the diagnostic log level", () => {
  assert.equal(
    loadConfig({
      YANDEX_WORDSTAT_API_KEY: "key",
      YANDEX_WORDSTAT_LOG_LEVEL: "debug",
    }).logLevel,
    "debug",
  );
  assert.throws(
    () =>
      loadConfig({
        YANDEX_WORDSTAT_API_KEY: "key",
        YANDEX_WORDSTAT_LOG_LEVEL: "verbose",
      }),
    /YANDEX_WORDSTAT_LOG_LEVEL/,
  );
});

test("configuration does not require folderId for service-account credentials", () => {
  const config = loadConfig({ YANDEX_WORDSTAT_IAM_TOKEN: "test-token" });
  assert.equal(config.credentialKind, "iam-token");
  assert.equal(config.folderId, undefined);
});

test("configuration rejects missing or conflicting credentials", () => {
  for (const env of [{}, { YANDEX_WORDSTAT_API_KEY: "a", YANDEX_WORDSTAT_IAM_TOKEN: "b" }]) {
    assert.throws(
      () => loadConfig(env),
      (error: unknown) => {
        return error instanceof WordstatError && error.code === "CONFIGURATION_ERROR";
      },
    );
  }
});

test("configuration validates numeric overrides without silent fallback", () => {
  assert.throws(
    () =>
      loadConfig({
        YANDEX_WORDSTAT_API_KEY: "key",
        YANDEX_WORDSTAT_MAX_RETRIES: "2.5",
      }),
    /must be an integer/,
  );
  assert.equal(
    loadConfig({ YANDEX_WORDSTAT_API_KEY: "key", YANDEX_WORDSTAT_MAX_RPH: "0" }).maxRph,
    0,
  );
});
