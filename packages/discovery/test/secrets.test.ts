import { describe, expect, it } from "vitest";
import { isSecretPath, runDiscovery } from "../src/index";
import { fixture } from "./helpers";

describe("secret exclusion", () => {
  it("classifies secret paths", () => {
    for (const p of [
      ".env",
      ".env.local",
      "a/b/.env.production",
      "certs/server.pem",
      "tls/app.key",
      "store.p12",
      "home/id_rsa",
      "id_rsa.pub",
      "id_ed25519",
      "config/credentials.json",
      "secrets/token.txt",
      "app/secrets/x/y.yaml",
      ".npmrc",
      ".pypirc",
    ]) {
      expect(isSecretPath(p), p).toBe(true);
    }
    for (const p of ["src/env.ts", "README.md", "package.json", "src/secretsmanager.ts"]) {
      expect(isSecretPath(p), p).toBe(false);
    }
  });

  it("never reads secrets", async () => {
    const { registry, files } = await runDiscovery({ repo: fixture("ts-monorepo"), task: "x" });
    expect(JSON.stringify(registry.toJSON())).not.toContain("FAKE_SECRET_VALUE_123");
    expect(files.files).not.toContain(".env");
  });

  it("readText returns null for secrets, missing files and escapes", async () => {
    let seen: string[] = [];
    await runDiscovery({
      repo: fixture("ts-monorepo"),
      task: "x",
      detectors: [
        {
          id: "probe",
          categories: ["runtime"],
          always: true,
          run: async (ctx) => {
            seen = [
              String(await ctx.readText(".env")),
              String(await ctx.readText("nope.txt")),
              String(await ctx.readText("../python-service/.python-version")),
              String((await ctx.readText(".nvmrc"))?.trim()),
            ];
            return [];
          },
        },
      ],
    });
    expect(seen).toEqual(["null", "null", "null", "20.11.0"]);
  });
});
