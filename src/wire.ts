import { z } from "zod";

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const int64String = z
  .string()
  .regex(/^-?\d+$/, "Expected a protobuf int64 decimal string")
  .max(20)
  .refine((value) => {
    try {
      const parsed = BigInt(value);
      return parsed >= INT64_MIN && parsed <= INT64_MAX;
    } catch {
      return false;
    }
  }, "Expected a signed protobuf int64 value");
const finiteWireNumber = z.union([z.number().finite(), z.string()]).transform((value, context) => {
  if (typeof value === "string" && !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    context.addIssue({ code: "custom", message: "Expected a decimal numeric string" });
    return z.NEVER;
  }
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) {
    context.addIssue({ code: "custom", message: "Expected a finite numeric value" });
    return z.NEVER;
  }
  return number;
});

export const phraseInfoSchema = z.object({
  phrase: z.string().max(1_000),
  count: int64String,
});

export const topResponseSchema = z.object({
  totalCount: int64String,
  results: z.array(phraseInfoSchema),
  associations: z.array(phraseInfoSchema),
});

export const dynamicsResponseSchema = z.object({
  results: z.array(
    z.object({
      date: z.string().max(64),
      count: int64String,
      share: finiteWireNumber,
    }),
  ),
});

export const regionsResponseSchema = z.object({
  results: z.array(
    z.object({
      region: z.string().min(1).max(128),
      count: int64String,
      share: finiteWireNumber,
      affinityIndex: finiteWireNumber,
    }),
  ),
});

export interface RegionNode {
  id: string;
  label: string;
  children: RegionNode[];
}

export const regionNodeSchema: z.ZodType<RegionNode> = z.lazy(() =>
  z.object({
    id: z.string().min(1).max(128),
    label: z.string().max(1_000),
    children: z.array(regionNodeSchema).default([]),
  }),
);

export const regionsTreeResponseSchema = z.object({
  regions: z.array(regionNodeSchema),
});

export type TopResponse = z.output<typeof topResponseSchema>;
export type DynamicsResponse = z.output<typeof dynamicsResponseSchema>;
export type RegionsResponse = z.output<typeof regionsResponseSchema>;
export type RegionsTreeResponse = z.output<typeof regionsTreeResponseSchema>;
