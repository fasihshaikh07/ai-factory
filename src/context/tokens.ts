// Token counting proxy (context-builder §2.5 step 6). [EVAL]: calibrate against vendor counts.
// ~3.5 chars/token for mixed code and English; Claude tokenises ~30% more.
export function estimateTokens(text: string, model = ""): number {
  const base = Math.ceil(text.length / 3.5);
  return /claude|opus|sonnet|haiku/i.test(model) ? Math.ceil(base * 1.3) : base;
}
