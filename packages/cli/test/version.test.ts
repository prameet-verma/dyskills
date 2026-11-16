import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/run";
import { CLI_VERSION } from "../src/version";

describe("--version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8"));
    expect(CLI_VERSION).toBe(pkg.version);
  });

  it("prints one JSON object on stdout and exits 0", async () => {
    const r = await runCli(["--version"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, schemaVersion: "1", version: CLI_VERSION });
    expect(r.stdout.endsWith("\n")).toBe(true);
    expect(r.stderr).toBe("");
  });

  it("accepts -V too", async () => {
    const r = await runCli(["-V"]);
    expect(JSON.parse(r.stdout).version).toBe(CLI_VERSION);
  });
});
