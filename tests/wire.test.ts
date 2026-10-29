import assert from "node:assert/strict";
import test from "node:test";

import { dynamicsResponseSchema, regionsResponseSchema, topResponseSchema } from "../src/wire.js";

test("confirmed int64 fields remain strings", () => {
  const parsed = topResponseSchema.parse({
    totalCount: "9007199254740993",
    results: [{ phrase: "example", count: "9007199254740993" }],
    associations: [],
  });
  assert.equal(parsed.totalCount, "9007199254740993");
  assert.equal(parsed.results[0]?.count, "9007199254740993");
  assert.throws(() => topResponseSchema.parse({ totalCount: 1, results: [], associations: [] }));
});

test("share and affinityIndex accept confirmed numbers and documented strings", () => {
  const dynamics = dynamicsResponseSchema.parse({
    results: [{ date: "2026-09-01T00:00:00Z", count: "1", share: "0.5" }],
  });
  const regions = regionsResponseSchema.parse({
    results: [{ region: "213", count: "1", share: 0.25, affinityIndex: "1.5" }],
  });
  assert.equal(dynamics.results[0]?.share, 0.5);
  assert.equal(regions.results[0]?.share, 0.25);
  assert.equal(regions.results[0]?.affinityIndex, 1.5);
});

test("wire numbers reject blank, non-decimal and non-finite strings", () => {
  for (const share of ["", "   ", "0x10", "Infinity", "1e10000"]) {
    assert.throws(() =>
      dynamicsResponseSchema.parse({
        results: [{ date: "2026-09-01T00:00:00Z", count: "1", share }],
      }),
    );
  }
  assert.equal(
    dynamicsResponseSchema.parse({
      results: [{ date: "2026-09-01T00:00:00Z", count: "1", share: "-1.25e-2" }],
    }).results[0]?.share,
    -0.0125,
  );
});

test("protobuf int64 strings stay inside the signed int64 range", () => {
  for (const count of ["9223372036854775808", "-9223372036854775809", "9".repeat(100)]) {
    assert.throws(() =>
      topResponseSchema.parse({ totalCount: count, results: [], associations: [] }),
    );
  }
  assert.equal(
    topResponseSchema.parse({
      totalCount: "-9223372036854775808",
      results: [],
      associations: [],
    }).totalCount,
    "-9223372036854775808",
  );
});

test("external strings have per-field size limits", () => {
  assert.throws(() =>
    topResponseSchema.parse({
      totalCount: "1",
      results: [{ phrase: "x".repeat(1_001), count: "1" }],
      associations: [],
    }),
  );
});
