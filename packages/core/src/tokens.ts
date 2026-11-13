/**
 * Estimate the token count of `text` as `ceil(chars / 4)`.
 *
 * A deliberately tokenizer-free heuristic so every package budgets skill size identically
 * (PRD §8.5). Never throws; returns 0 for the empty string.
 * @param text - Text to measure, counted in UTF-16 code units.
 * @returns The estimated token count, a non-negative integer.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
