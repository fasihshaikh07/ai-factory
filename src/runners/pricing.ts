// USD per million tokens (list prices, cached 2026-06-24 from the Claude API reference).
// Estimates only; the cost caps use these. OpenAI prices come from config when known.
interface Price { input: number; output: number; cacheRead: number; cacheWrite: number }

const TABLE: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/** Unknown models are priced like the most expensive known one, so caps stay safe. */
const FALLBACK: Price = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };

const overrides = new Map<string, Price>();
export function setPrice(model: string, p: Price): void {
  overrides.set(model, p);
}

export function priceOf(model: string): Price {
  return overrides.get(model) ?? TABLE[model] ?? (model.startsWith("ollama/") ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : FALLBACK);
}

export function costUsd(model: string, u: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number }): number {
  const p = priceOf(model);
  return (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1_000_000;
}
