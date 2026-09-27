import { z } from "zod";

export * from "./common.js";
export * from "./artifacts.js";
export * from "./verify.js";
export * from "./ledger.js";
export * from "./pack.js";

export type JSONSchema = Record<string, unknown>;

/** JSON Schema for a model's structured output. zod is the single source. */
export function toJsonSchema(schema: z.ZodType): JSONSchema {
  return z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) as JSONSchema;
}
