/** A package runner (with any option tokens such as `-y`, `--yes`, `--`) aimed at dynamic-skills. */
export const R19_RUNNER =
  /\b(?:npx|pnpx|bunx|pnpm\s+dlx|yarn\s+dlx|npm\s+exec)(?:\s+-{1,2}\S*)*\s+dynamic-skills\b/;
