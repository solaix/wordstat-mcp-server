import assert from "node:assert/strict";
import test from "node:test";

import {
  dynamicsResponseSchema,
  regionsResponseSchema,
  regionsTreeResponseSchema,
  topResponseSchema,
} from "../src/wire.js";

test("omitted protobuf defaults are normalized without weakening identity fields", () => {
  assert.deepEqual(topResponseSchema.parse({}), {
    totalCount: "0",
    results: [],
    associations: [],
  });
  assert.deepEqual(topResponseSchema.parse({ results: [{ phrase: "zero demand" }] }).results, [
    { phrase: "zero demand", count: "0" },
  ]);
  assert.deepEqual(dynamicsResponseSchema.parse({ results: [{ date: "2026-10-07T00:00:00Z" }] }), {
    results: [{ date: "2026-10-07T00:00:00Z", count: "0", share: 0 }],
  });
  assert.deepEqual(regionsResponseSchema.parse({}), { results: [] });
  assert.deepEqual(regionsResponseSchema.parse({ results: [{ region: "213" }] }), {
    results: [{ region: "213", count: "0", share: 0, affinityIndex: 0 }],
  });
  assert.deepEqual(regionsTreeResponseSchema.parse({}), { regions: [] });
  assert.deepEqual(regionsTreeResponseSchema.parse({ regions: [{ id: "213", label: "Moscow" }] }), {
    regions: [{ id: "213", label: "Moscow", children: [] }],
  });

  assert.throws(() => dynamicsResponseSchema.parse({ results: [{ count: "0", share: 0 }] }));
  assert.throws(() => regionsResponseSchema.parse({ results: [{ count: "0" }] }));
});

test("explicit null and invalid protobuf defaults remain contract errors", () => {
  assert.throws(() => topResponseSchema.parse({ totalCount: null }));
  assert.throws(() => topResponseSchema.parse({ results: null }));
  assert.throws(() =>
    dynamicsResponseSchema.parse({ results: [{ date: "2026-10-07", count: null }] }),
  );
  assert.throws(() => regionsResponseSchema.parse({ results: [{ region: "213", share: null }] }));
  assert.throws(() => regionsTreeResponseSchema.parse({ regions: null }));
});

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
