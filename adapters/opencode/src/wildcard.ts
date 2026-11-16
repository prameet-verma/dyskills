/**
 * Full-string glob match of `pattern` against `input`: `*` matches any sequence (including
 * empty), `?` matches exactly one character, every other character matches itself literally.
 * Dynamic-programming table, `O(length(input) * length(pattern))`, no backtracking, so no regex
 * is ever built from a user-supplied pattern.
 *
 * @param input - The text being matched.
 * @param pattern - The glob pattern.
 * @returns Whether `pattern` matches the whole of `input`.
 */
function globMatch(input: string, pattern: string): boolean {
  const n = input.length;
  const m = pattern.length;
  let prev = new Array<boolean>(m + 1).fill(false);
  prev[0] = true;
  for (let j = 1; j <= m; j++) prev[j] = (prev[j - 1] ?? false) && pattern[j - 1] === "*";
  for (let i = 1; i <= n; i++) {
    const cur = new Array<boolean>(m + 1).fill(false);
    for (let j = 1; j <= m; j++) {
      const pc = pattern[j - 1];
      if (pc === "*") cur[j] = (cur[j - 1] ?? false) || (prev[j] ?? false);
      else if (pc === "?" || pc === input[i - 1]) cur[j] = prev[j - 1] ?? false;
    }
    prev = cur;
  }
  return prev[m] ?? false;
}

/**
 * Mirrors OpenCode's own `Wildcard.match`: a full-string glob match on `*`/`?`, where a pattern
 * ending in `" *"` also matches the bare prefix with no trailing space (so `"dynamic-skills *"`
 * matches the literal command `"dynamic-skills"` too). Case-sensitive. Backslashes are normalized
 * to `/` first, as OpenCode does, though neither appears in the command text this adapter matches.
 *
 * @param input - The text being matched (a command, or an action name).
 * @param pattern - The glob pattern from a permission rule.
 * @returns Whether `pattern` matches `input`.
 */
export function wildcardMatch(input: string, pattern: string): boolean {
  const normInput = input.replaceAll("\\", "/");
  const normPattern = pattern.replaceAll("\\", "/");
  if (normPattern.endsWith(" *") && globMatch(normInput, normPattern.slice(0, -2))) return true;
  return globMatch(normInput, normPattern);
}
