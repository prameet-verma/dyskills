/** Maximum length (in code points) of a sanitised evidence value, including the trailing ellipsis. */
const MAX_VALUE_LENGTH = 500;

/**
 * Secret shapes that must never reach the registry, the agent prompt or a generated skill
 * (PRD §7: repository content is untrusted data).
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /ghp_[A-Za-z0-9]{36}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  // Whole PEM block (header, base64 body, footer); an unterminated block is redacted to the end.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  /gh[osu]_[A-Za-z0-9]{36}/g,
  /xox[bp]-[A-Za-z0-9-]{10,}/g,
];

/**
 * Replaces secret-shaped values with `[REDACTED]` and changes nothing else (no whitespace or
 * bracket rewriting), for callers such as code excerpts that must keep their layout.
 *
 * @param raw - Untrusted text.
 * @returns The text with every {@link SECRET_PATTERNS} match redacted.
 */
export function redactSecrets(raw: string): string {
  let out = raw;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[REDACTED]");
  return out;
}

/**
 * Makes a raw repository-derived string safe to store and to embed in a fenced data block.
 *
 * Order matters: secrets are redacted first so whitespace collapsing cannot split a token, then
 * whitespace is collapsed, then angle brackets become `‹` `›` so the value cannot close the
 * evidence fence, and finally the result is truncated to exactly 500 code points (499 plus `…`; a surrogate pair is never split).
 * Pure and idempotent; never throws.
 *
 * @param raw - Untrusted text observed in the repository.
 * @returns The sanitised value, at most 500 code points.
 */
export function sanitizeEvidenceValue(raw: string): string {
  let out = redactSecrets(raw);
  out = out.replace(/\s+/g, " ").replace(/</g, "‹").replace(/>/g, "›");
  // Count code points, not UTF-16 units, so a surrogate pair is never split.
  // A string within the limit in UTF-16 units is within it in code points, so skip the split.
  if (out.length > MAX_VALUE_LENGTH) {
    const points = Array.from(out);
    if (points.length > MAX_VALUE_LENGTH) {
      out = points.slice(0, MAX_VALUE_LENGTH - 1).join("") + "…";
    }
  }
  return out;
}
