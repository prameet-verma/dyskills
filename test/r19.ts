/**
 * A package runner (`npx`, `pnpx`, `bunx`, `pnpm dlx`, `yarn dlx`, `npm exec|x`, `bun x`) followed
 * only by option tokens (`-y`, `--yes`, `--`, `-p pkg`: a dash token and at most one value that does
 * not start with a dash) and then a `dynamic-skills` token, optionally quoted. Prose between the
 * runner and the name ("Do not use npx: install dynamic-skills") therefore does not match. Each
 * option can take a value or not, but a value never starts with a dash, so the alternatives rarely
 * overlap; the cost is bounded by the line length times a small constant in practice (tested with
 * a 5,000-flag run), not formally linear. Match text passed through {@link joinContinuations}.
 */
export const R19_RUNNER =
  /\b(?:npx|pnpx|bunx|pnpm[ \t]+dlx|yarn[ \t]+dlx|npm[ \t]+(?:exec|x)|bun[ \t]+x)(?:[ \t]+-\S*(?:[ \t]+[^-\s]\S*)?)*[ \t]+['"]?dynamic-skills\b/;

/** Joins backslash line continuations so a runner split across lines is matched as one command. */
export function joinContinuations(text: string): string {
  return text.replace(/\\\r?\n[ \t]*/g, " ");
}
