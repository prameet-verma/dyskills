/**
 * A package runner (`npx`, `pnpx`, `bunx`, `pnpm dlx`, `yarn dlx`, `npm exec|x`, `bun x`) followed,
 * on the same line, by a `dynamic-skills` token (optionally quoted, after any flags or option
 * values). Single spaces or tabs separate the runner words, so the scan is linear.
 */
export const R19_RUNNER =
  /\b(?:npx|pnpx|bunx|pnpm[ \t]+dlx|yarn[ \t]+dlx|npm[ \t]+(?:exec|x)|bun[ \t]+x)\b[^\n]*?(?<![\w-])['"]?dynamic-skills\b/;
