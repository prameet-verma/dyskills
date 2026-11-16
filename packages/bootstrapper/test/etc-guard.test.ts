import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("test hygiene", () => {
  it("never scans without an injected etcDir (the real /etc must not be read)", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      if (file === "etc-guard.test.ts") continue;
      const parts = readFileSync(join(dir, file), "utf8").split("scanExistingSkills(");
      parts.slice(1).forEach((rest, i) => {
        if (!rest.slice(0, 250).includes("etcDir")) offenders.push(`${file} call #${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
