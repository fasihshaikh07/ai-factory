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

/**
 * JSON Schema for the coding agent's structured output. Claude Code validates it with a draft-07
 * checker that rejects a 2020-12 `$schema`, so: draft-07, and no `$schema` line at all.
 */
export function toAgentJsonSchema(schema: z.ZodType): JSONSchema {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as JSONSchema;
  void _drop;
  return rest;
}
