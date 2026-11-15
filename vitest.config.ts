import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["packages/*/test/**/*.test.ts"] } },
      // Repository-level checks (documentation set); fast, no build needed.
      { test: { name: "repo", include: ["test/*.test.ts"] } },
      {
        // End-to-end tests spawn the built binary, so the project builds it once up front
        // (`pnpm test` alone must work on a fresh checkout) and a unit-only run stays fast.
        test: {
          name: "e2e",
          include: ["test/e2e/**/*.test.ts"],
          globalSetup: ["test/e2e/global-setup.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
