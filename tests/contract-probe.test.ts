import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProbeCases,
  parseArgs,
  parseProbeResponse,
  probeRunFailed,
  sanitize,
  type JsonValue,
} from "../scripts/contract-probe.js";

test("dry run is the default and live execution requires an explicit flag", () => {
  assert.deepEqual(parseArgs([]), {
    confirmLive: false,
    listOnly: false,
    selectedCases: [],
    outputDirectory: "contract-results",
  });
  assert.equal(parseArgs(["--confirm-live"]).confirmLive, true);
});

test("probe cases use lag-tolerant daily and complete weekly and monthly boundaries", () => {
  const cases = buildProbeCases(new Date("2026-09-28T17:00:00Z"), "test phrase", "folder");
  const byName = Object.fromEntries(cases.map((item) => [item.name, item]));

  assert.deepEqual(byName["dynamics-daily"]?.body, {
    phrase: "test phrase",
    devices: ["DEVICE_ALL"],
    period: "PERIOD_DAILY",
    fromDate: "2026-08-23T00:00:00Z",
    toDate: "2026-08-29T00:00:00Z",
    folderId: "folder",
  });
  assert.equal(byName["dynamics-weekly"]?.body.fromDate, "2026-08-31T00:00:00Z");
  assert.equal(byName["dynamics-weekly"]?.body.toDate, "2026-09-27T00:00:00Z");
  assert.equal(byName["dynamics-monthly"]?.body.fromDate, "2026-06-01T00:00:00Z");
  assert.equal(byName["dynamics-monthly"]?.body.toDate, "2026-08-31T00:00:00Z");
});

test("saved fixtures redact query text, folder IDs, labels and external messages", () => {
  const input: JsonValue = {
    phrase: "secret phrase",
    folderId: "folder-id",
    nested: [{ label: "Moscow", id: "213" }],
    error: { message: "external error", code: 7 },
    unknown: "response repeated secret phrase",
    nonJsonBody: "unstructured response",
  };
  assert.deepEqual(sanitize(input, "", ["secret phrase"]), {
    phrase: "<redacted>",
    folderId: "<redacted>",
    nested: [{ label: "<redacted>", id: "213" }],
    error: { message: "<redacted>", code: 7 },
    unknown: "response repeated <redacted>",
    nonJsonBody: "<redacted>",
  });
});

test("the complete probe plan remains below the default hourly budget", () => {
  const cases = buildProbeCases(new Date("2026-09-28T17:00:00Z"), "test");
  assert.equal(cases.length, 9);
  assert.ok(cases.length < 100);
  assert.equal(cases.filter((item) => item.billable).length, 8);
  assert.deepEqual(
    cases.find((item) => item.name === "dynamics-weekly-minus-operator")?.expectedStatuses,
    [200],
  );
});

test("probe run fails on incomplete execution, transport failures or unexpected statuses", () => {
  assert.equal(probeRunFailed(3, 3, 0, 0), false);
  assert.equal(probeRunFailed(3, 2, 0, 0), true);
  assert.equal(probeRunFailed(3, 3, 1, 0), true);
  assert.equal(probeRunFailed(3, 3, 0, 1), true);
});

test("probe response reader enforces its byte limit", async () => {
  await assert.rejects(
    parseProbeResponse(new Response("{}", { headers: { "content-length": String(1_048_577) } })),
    /size limit/,
  );
});
