import { redactSecrets } from "@dynamic-skills/evidence-registry";

/**
 * Control characters other than `\n` (0x0A) and `\t` (0x09), including DEL and ESC, which
 * could carry terminal escape sequences into an agent transcript.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/**
 * Prepares raw file text for inclusion in a Context Packet (PRD §6.4, FR-08, FR-13).
 *
 * Line endings are normalised and control characters removed first, so a control character
 * cannot split a token and hide it from redaction; secrets are then redacted before truncation
 * so a cut cannot leave a recognisable fragment. Angle brackets are
 * kept: packets are JSON data and are never embedded in the agent brief, so fence-escaping is
 * unnecessary and would corrupt code.
 *
 * @param raw - Untrusted file content.
 * @param maxChars - Maximum excerpt length.
 * @returns The excerpt and whether it was cut. Pure; never throws.
 */
export function sanitizeExcerpt(
  raw: string,
  maxChars: number,
): { excerpt: string; truncated: boolean } {
  const clean = redactSecrets(raw.replace(/\r\n?/g, "\n").replace(CONTROL_CHARS, ""));
  return clean.length > maxChars
    ? { excerpt: clean.slice(0, maxChars), truncated: true }
    : { excerpt: clean, truncated: false };
}
