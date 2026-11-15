import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_DETECTORS, isSecretPath, runDiscovery } from "../src/index";
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
      ".ENV",
      "Server.PEM",
      ".envrc",
      ".netrc",
      "a.pfx",
      "store.jks",
      "Secrets/x",
      ".pypirc",
    ]) {
      expect(isSecretPath(p), p).toBe(true);
    }
    for (const p of ["src/env.ts", "README.md", "package.json", "src/secretsmanager.ts"]) {
      expect(isSecretPath(p), p).toBe(false);
    }
  });

  it("classifies infrastructure, registry and service credential files (M5)", () => {
    for (const p of [
      "infra/prod.tfvars",
      "infra/prod.tfvars.json",
      "terraform.tfstate",
      "infra/terraform.tfstate.backup",
      ".git-credentials",
      ".aws/credentials",
      ".aws/config",
      "home/.aws/sso/cache/x.json",
      ".docker/config.json",
      "home/.docker/config.json",
      "secrets.yaml",
      "config/secrets.json",
      "Secrets.ENC.yaml",
      "kubeconfig",
      ".kube/config",
      "deploy/.kube/config",
      "android/release.keystore",
      "store.JKS",
      ".htpasswd",
      "etc/.netrc",
      ".pgpass",
    ]) {
      expect(isSecretPath(p), p).toBe(true);
    }
    for (const p of [
      "docker/config.json",
      ".docker/daemon.json",
      "kube/config",
      ".kube/cache/x",
      "config.json",
      "src/secretsmanager.ts",
      "docs/terraform.md",
      "kubeconfig.md",
      "my-secrets.md",
    ]) {
      expect(isSecretPath(p), p).toBe(false);
    }
  });

  it("fails closed on every secrets.* variant that is not plain source (R24)", () => {
    for (const p of [
      "secrets.yaml.bak",
      "secrets.json.orig",
      "secrets.env.local",
      "secrets.gpg",
      "secrets.asc",
      "secrets.age",
      "secrets.yaml.gpg",
      "secrets.json5",
      "secrets.jsonc",
      "secrets.hcl",
      "secrets.csv",
      "secrets.dat",
      "secrets.db",
      "secrets.sqlite",
      "secrets.kdbx",
      "secrets.vault",
      "secrets.encrypted",
      "secrets.bak",
      "secrets.old",
      "secrets.backup",
      "secrets.yaml~",
      "secrets.yaml.swp",
      "secrets.yaml.dist",
      "secrets.yaml.template",
      "secrets.yml.example",
      "secrets.env.example",
      "secrets.zip",
      "secrets.tar.gz",
      "secrets.7z",
      "secrets.",
      "secrets.yaml",
      "config/secrets.json",
      "secrets.enc.yaml",
      "secrets/db.txt",
      "secrets.sops.json",
      "secrets.enc.ts",
      "secrets.ts.enc",
      "secrets.dec.ts",
      "secrets.json.ts",
      "SECRETS.TOML",
      "secrets.prod.env",
      "a/secrets.cfg",
      "secrets.sh",
      "secrets.bash",
      "secrets.zsh",
      "secrets.ps1",
      "secrets.md",
      "secrets",
      "dir/secrets",
      ".secrets",
      ".SECRETS",
      "app/.secrets/token",
      "secrets.ts~",
      "secrets.d.ts.gpg",
    ]) {
      expect(isSecretPath(p), p).toBe(true);
    }
  });

  it("keeps plain source files named secrets visible", () => {
    for (const p of [
      "secrets.ts",
      "src/secrets.py",
      "secrets.test.ts",
      "secrets.d.ts",
      "secrets.js",
      "secrets.go",
      "packages/discovery/src/secrets.ts",
      "secrets.tsx",
      "secrets.rs",
      "secrets.spec.js",
      "Secrets.Java",
    ]) {
      expect(isSecretPath(p), p).toBe(false);
    }
  });

  it("stays linear on a hostile secrets.* name", () => {
    const started = performance.now();
    isSecretPath(`secrets.${"a.".repeat(50_000)}x`);
    isSecretPath(`secrets.${"ts.".repeat(50_000)}ts`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("matches in linear time on hostile names", () => {
    const hostile = `${"a/".repeat(5_000)}${".".repeat(50_000)}tfvarsx`;
    const started = performance.now();
    expect(isSecretPath(hostile)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
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

  it("does not follow symlinks to secrets or outside the repo", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ds-outside-"));
    writeFileSync(
      join(outside, "ext.json"),
      '{"packageManager":"yarn@1.0.0","name":"OUTSIDE_VALUE"}',
    );
    const repo = mkdtempSync(join(tmpdir(), "ds-link-"));
    writeFileSync(join(repo, ".env"), "LEAK_SECRET_999");
    symlinkSync(join(outside, "ext.json"), join(repo, "package.json"));
    symlinkSync(join(repo, ".env"), join(repo, ".nvmrc"));
    const reads: (string | null)[] = [];
    const { registry } = await runDiscovery({
      repo,
      task: "x",
      detectors: [
        ...ALL_DETECTORS,
        {
          id: "probe",
          categories: ["runtime"],
          always: true,
          run: async (ctx) => {
            reads.push(await ctx.readText("package.json"), await ctx.readText(".nvmrc"));
            return [];
          },
        },
      ],
    });
    expect(reads).toEqual([null, null]);
    const json = JSON.stringify(registry.toJSON());
    expect(json).not.toContain("LEAK_SECRET_999");
    expect(json).not.toContain("yarn");
  });
});
