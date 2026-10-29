import assert from "node:assert/strict";
import test from "node:test";

import { assertSupportedDynamicsOperators, resolveDates } from "../src/dates.js";

const NOW = new Date("2026-09-28T17:00:00Z");

test("automatic daily, weekly and monthly ranges use complete Moscow periods", () => {
  assert.deepEqual(resolveDates({ period: "daily", autoDates: true }, NOW), {
    fromDate: "2026-07-30T00:00:00Z",
    toDate: "2026-09-27T00:00:00Z",
    fromDatePublic: "2026-07-30",
    toDatePublic: "2026-09-27",
    dateSource: "auto",
    currentPeriodExcluded: true,
  });
  const weekly = resolveDates({ period: "weekly", autoDates: true }, NOW);
  assert.equal(weekly.fromDatePublic, "2025-09-29");
  assert.equal(weekly.toDatePublic, "2026-09-27");
  const monthly = resolveDates({ period: "monthly", autoDates: true }, NOW);
  assert.equal(monthly.fromDatePublic, "2025-09-01");
  assert.equal(monthly.toDatePublic, "2026-08-31");
});

test("explicit dates are validated without silent alignment", () => {
  assert.throws(
    () =>
      resolveDates(
        {
          period: "weekly",
          fromDate: "2026-09-01",
          toDate: "2026-09-27",
          autoDates: true,
        },
        NOW,
      ),
    /must be a Monday/,
  );
  assert.throws(
    () => resolveDates({ period: "daily", autoDates: false }, NOW),
    /from_date is required/,
  );
});

test("weekly and monthly reject unsupported operators but not word hyphens", () => {
  assert.doesNotThrow(() => assertSupportedDynamicsOperators("санкт-петербург +отель", "weekly"));
  assert.throws(
    () => assertSupportedDynamicsOperators("велосипед -ремонт", "weekly"),
    /support only the \+ Wordstat operator/,
  );
  assert.doesNotThrow(() => assertSupportedDynamicsOperators('"велосипед"', "daily"));
});
