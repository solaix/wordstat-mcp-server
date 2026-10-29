import { WordstatError } from "./errors.js";

export type PublicPeriod = "daily" | "weekly" | "monthly";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function dateFromParts(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function parseDate(value: string): Date {
  const match = DATE_PATTERN.exec(value);
  if (!match) throw new WordstatError("VALIDATION_ERROR", `Invalid date: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = dateFromParts(year, month, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new WordstatError("VALIDATION_ERROR", `Invalid calendar date: ${value}`);
  }
  return date;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, amount: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + amount);
  return result;
}

function addMonths(date: Date, amount: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + amount, 1));
}

function moscowToday(now: Date): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return dateFromParts(Number(values.year), Number(values.month), Number(values.day));
}

function lastCompleteBoundary(period: PublicPeriod, now: Date): Date {
  const today = moscowToday(now);
  if (period === "daily") return addDays(today, -1);
  if (period === "weekly") {
    const mondayOffset = (today.getUTCDay() + 6) % 7;
    return addDays(today, -mondayOffset - 1);
  }
  return addDays(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)), -1);
}

function standardStart(period: PublicPeriod, end: Date): Date {
  if (period === "daily") return addDays(end, -59);
  if (period === "weekly") return addDays(end, -7 * 52 + 1);
  return addMonths(new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1)), -11);
}

function backwardsStart(period: PublicPeriod, end: Date): Date {
  return standardStart(period, end);
}

function validateBoundaries(period: PublicPeriod, from: Date, to?: Date): void {
  if (to && from > to) {
    throw new WordstatError("VALIDATION_ERROR", "from_date must not be after to_date");
  }
  if (period === "weekly") {
    if (from.getUTCDay() !== 1) {
      throw new WordstatError("VALIDATION_ERROR", "Weekly from_date must be a Monday");
    }
    if (to && to.getUTCDay() !== 0) {
      throw new WordstatError("VALIDATION_ERROR", "Weekly to_date must be a Sunday");
    }
  }
  if (period === "monthly") {
    if (from.getUTCDate() !== 1) {
      throw new WordstatError(
        "VALIDATION_ERROR",
        "Monthly from_date must be the first day of a month",
      );
    }
    if (to && addDays(to, 1).getUTCDate() !== 1) {
      throw new WordstatError(
        "VALIDATION_ERROR",
        "Monthly to_date must be the last day of a month",
      );
    }
  }
  if (period === "daily" && to) {
    const span = Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (span > 60) {
      throw new WordstatError("VALIDATION_ERROR", "Daily range must not exceed 60 days");
    }
  }
}

export interface ResolvedDates {
  fromDate: string;
  toDate?: string;
  fromDatePublic: string;
  toDatePublic?: string;
  dateSource: "explicit" | "auto" | "mixed";
  currentPeriodExcluded: boolean;
}

export function resolveDates(
  input: {
    period: PublicPeriod;
    fromDate?: string;
    toDate?: string;
    autoDates: boolean;
  },
  now = new Date(),
): ResolvedDates {
  let from = input.fromDate ? parseDate(input.fromDate) : undefined;
  let to = input.toDate ? parseDate(input.toDate) : undefined;
  const explicitCount = Number(Boolean(from)) + Number(Boolean(to));

  if (!input.autoDates && !from) {
    throw new WordstatError("VALIDATION_ERROR", "from_date is required when auto_dates is false");
  }

  const lastComplete = lastCompleteBoundary(input.period, now);
  if (input.autoDates) {
    if (!from && !to) {
      to = lastComplete;
      from = standardStart(input.period, to);
    } else if (from && !to) {
      to = lastComplete;
    } else if (!from && to) {
      from = backwardsStart(input.period, to);
    }
  }
  if (!from) throw new WordstatError("VALIDATION_ERROR", "from_date is required");

  validateBoundaries(input.period, from, to);
  return {
    fromDate: `${formatDate(from)}T00:00:00Z`,
    ...(to ? { toDate: `${formatDate(to)}T00:00:00Z` } : {}),
    fromDatePublic: formatDate(from),
    ...(to ? { toDatePublic: formatDate(to) } : {}),
    dateSource: explicitCount === 2 ? "explicit" : explicitCount === 0 ? "auto" : "mixed",
    currentPeriodExcluded: Boolean(to && to <= lastComplete),
  };
}

export function assertSupportedDynamicsOperators(phrase: string, period: PublicPeriod): void {
  if (period === "daily") return;
  const withoutHyphenatedWords = phrase.replace(/[\p{L}\p{N}]-[\p{L}\p{N}]/gu, "");
  const hasUnsupportedSymbol = [...phrase].some((character) => '!"[]()|'.includes(character));
  if (hasUnsupportedSymbol || /(^|\s)-(?=\S)/u.test(withoutHyphenatedWords)) {
    throw new WordstatError(
      "VALIDATION_ERROR",
      "Weekly and monthly dynamics support only the + Wordstat operator",
    );
  }
}
