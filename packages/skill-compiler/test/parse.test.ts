import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fingerprintFile } from "@dynamic-skills/evidence-registry";
import { describe, expect, it } from "vitest";
import { deriveRequirements, consolidateAnalysis } from "@dynamic-skills/context-analyzer";
import { runDiscovery } from "@dynamic-skills/discovery";
import {
  BundleError,
  ASSUMPTION_PATTERN,
  CITATION_PATTERN,
  INFERENCE_PATTERN,
  MAX_SMOKE_BYTES,
  loadSmokeEval,
  parseSkillBundle,
} from "../src/index";
import { ANALYSIS, PACKET, ROOT } from "./helpers";

const F = (p: string): string => resolve(ROOT, "fixtures/skills", p);

describe("parseSkillBundle", () => {
  it("parses the golden new skill", async () => {
    const s = await parseSkillBundle(F("valid"));
    expect(s.name).toBe("order-cache-specialist");
    expect(s.references).toHaveLength(0);
    expect(s.tokenEstimate).toBeLessThan(2000);
    expect(s.augments).toBeNull();
    expect(s.body).toContain("## Ownership");
  });

  it("parses the golden augmentation and pins the base sha", async () => {
    const s = await parseSkillBundle(F("augmentation"));
    const sha = await fingerprintFile(F("augmentation-base/order-caching/SKILL.md"));
    expect(s.augments).toEqual({ name: "order-caching", sha256: sha });
    expect(typeof s.frontmatter.metadata).toBe("object");
  });

  it("extracts relative markdown references only", async () => {
    const root = mkdtempSync(join(tmpdir(), "bundle-"));
    mkdirSync(join(root, "my-skill"));
    writeFileSync(
      join(root, "my-skill", "SKILL.md"),
      "---\nname: my-skill\ndescription: d\n---\n# T\nSee [a](refs/a.md) [b](https://x.io) [c](mailto:a@b.c) [d](#top).\n",
    );
    const s = await parseSkillBundle(root);
    expect(s.references).toEqual(["refs/a.md"]);
    expect(s.augments).toBeNull();
  });

  it("defaults a missing augments-sha256 to empty", async () => {
    const root = mkdtempSync(join(tmpdir(), "bundle-"));
    mkdirSync(join(root, "x-augment"));
    writeFileSync(
      join(root, "x-augment", "SKILL.md"),
      "---\nname: x-augment\ndescription: d\nmetadata:\n  augments: x\n---\nbody\n",
    );
    expect((await parseSkillBundle(root)).augments).toEqual({ name: "x", sha256: "" });
  });

  it("requires exactly one skill directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "bundle-"));
    mkdirSync(join(root, "a"));
    mkdirSync(join(root, "b"));
    const err = await parseSkillBundle(root).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BundleError);
    expect((err as Error).message).toBe("expected exactly one skill directory, found 2");
  });
});

function bundle(body: string, raw?: string): string {
  const root = mkdtempSync(join(tmpdir(), "bundle-"));
  mkdirSync(join(root, "my-skill"));
  writeFileSync(
    join(root, "my-skill", "SKILL.md"),
    raw ?? `---\nname: my-skill\ndescription: d\n---\n${body}\n`,
  );
  return root;
}

describe("parseSkillBundle hardening", () => {
  it("does not take quadratic time on pathological input", async () => {
    const t0 = Date.now();
    await parseSkillBundle(bundle("[".repeat(90_000))).catch(() => undefined);
    const big = bundle("", "---\nname: my-skill\ndescription: d\n---\n" + "[".repeat(200_000));
    const err = await parseSkillBundle(big).catch((e: unknown) => e);
    expect((err as Error).message).toBe("SKILL.md exceeds 100000 characters");
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("throws BundleError for a missing root", async () => {
    const err = await parseSkillBundle(join(tmpdir(), "no-such-root-xyz")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BundleError);
    expect((err as Error).message).toBe("expected exactly one skill directory, found 0");
  });

  it("treats a root that is a regular file as found 0", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "bundle-")), "skills");
    writeFileSync(f, "x");
    const err = await parseSkillBundle(f).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BundleError);
    expect((err as Error).message).toBe("expected exactly one skill directory, found 0");
  });

  it("rejects an oversized file by byte size before reading it", async () => {
    const root = bundle("");
    truncateSync(join(root, "my-skill", "SKILL.md"), 400_001);
    const err = await parseSkillBundle(root).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BundleError);
    expect((err as Error).message).toBe("SKILL.md exceeds 100000 characters");
  });

  it("closes a fence only with the same character and at least the opening length", async () => {
    const body = [
      "````",
      "```",
      "[inner](refs/inner.md)",
      "```",
      "[still](refs/still.md)",
      "````",
      "[after](refs/after.md)",
      "~~~",
      "```",
      "[tilde](refs/tilde.md)",
      "~~~",
      "[last](refs/last.md)",
    ].join("\n");
    const s = await parseSkillBundle(bundle(body));
    expect(s.references).toEqual(["refs/after.md", "refs/last.md"]);
  });

  it("rejects symlinked SKILL.md and symlinked skill directories", async () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    writeFileSync(join(outside, "SKILL.md"), "---\nname: s\ndescription: d\n---\n");
    const r1 = mkdtempSync(join(tmpdir(), "bundle-"));
    mkdirSync(join(r1, "s"));
    symlinkSync(join(outside, "SKILL.md"), join(r1, "s", "SKILL.md"));
    const r2 = mkdtempSync(join(tmpdir(), "bundle-"));
    symlinkSync(outside, join(r2, "s"));
    for (const r of [r1, r2]) {
      const err = await parseSkillBundle(r).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BundleError);
      expect((err as Error).message).toBe("skill files must not be symlinks");
    }
  });

  it("extracts only bundle-relative references", async () => {
    const body = [
      '[a](refs/a.md#sec) [b](refs/b.md?x=1) [c](<refs/c.md>) [d](refs/d.md "Title")',
      "[e](//evil.io/x) [f](/etc/passwd) [g](data:text/html,x) [h](javascript:alert(1)) [i](ftp://x/y) [j](C:/win)",
      "```",
      "[fenced](refs/fenced.md)",
      "```",
      "[k](refs/a.md)",
    ].join("\n");
    const s = await parseSkillBundle(bundle(body));
    expect(s.references).toEqual(["refs/a.md", "refs/b.md", "refs/c.md", "refs/d.md"]);
  });

  it("strips a leading UTF-8 BOM before the frontmatter", async () => {
    const s = await parseSkillBundle(
      bundle("", "\uFEFF---\nname: my-skill\ndescription: d\n---\nbody\n"),
    );
    expect(s.name).toBe("my-skill");
  });
});

describe("golden citations", () => {
  it("cites verified keys with [evidence:] and inferred keys with [inferred:]", async () => {
    const d = await runDiscovery({
      repo: resolve(ROOT, "fixtures/repos/ts-monorepo"),
      task: "add caching to order reads",
    });
    const out = consolidateAnalysis({
      result: ANALYSIS,
      registry: d.registry,
      packet: PACKET,
      files: d.files,
      requirements: deriveRequirements("add caching to order reads"),
      assumptions: [],
      revision: "x",
    });
    expect(out.evidenceAdded.length).toBeGreaterThan(0);
    const byKey = new Map(d.registry.list().map((e) => [e.key, e.confidence]));
    for (const dir of ["valid", "augmentation"]) {
      const s = await parseSkillBundle(F(dir));
      const keys = (re: RegExp): string[] => [...s.body.matchAll(re)].map((m) => m[1] ?? "");
      const cited = keys(CITATION_PATTERN);
      const inferred = keys(INFERENCE_PATTERN);
      expect(cited.length).toBeGreaterThan(0);
      expect(inferred.length).toBeGreaterThan(0);
      for (const k of cited) expect([k, byKey.get(k)]).toEqual([k, "verified"]);
      for (const k of inferred) expect([k, byKey.get(k)]).toEqual([k, "inferred"]);
    }
  });
});

describe("citation patterns", () => {
  const count = (re: RegExp, text: string): number => [...text.matchAll(re)].length;
  const timed = (fn: () => void): number => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };

  it("takes exactly one key per tag", () => {
    expect(count(CITATION_PATTERN, "[evidence: a.b] [evidence:c]")).toBe(2);
    expect(count(CITATION_PATTERN, "[evidence: a, b]")).toBe(0);
    expect(count(INFERENCE_PATTERN, "[inferred: a b]")).toBe(0);
    expect(count(ASSUMPTION_PATTERN, "[assumption: analysis-1]")).toBe(1);
    expect(count(CITATION_PATTERN, `[evidence:${" ".repeat(201)}a]`)).toBe(0);
  });

  it("scans adversarial input in linear time", () => {
    for (const re of [CITATION_PATTERN, INFERENCE_PATTERN, ASSUMPTION_PATTERN]) {
      const name = re.source.slice(2, re.source.indexOf(":"));
      const spaces = `[${name}:${" ".repeat(100_000)}`;
      const repeated = `[${name}:a`.repeat(20_000);
      expect(timed(() => count(re, spaces))).toBeLessThan(100);
      expect(timed(() => count(re, repeated))).toBeLessThan(100);
    }
  });
});

describe("loadSmokeEval", () => {
  it("parses the fixture", async () => {
    const e = await loadSmokeEval(F("smoke.json"));
    expect(e?.id).toBe("smoke-1");
  });
  it("returns null when absent", async () => {
    expect(await loadSmokeEval(F("nope.json"))).toBeNull();
  });
  it("throws on schema violation", async () => {
    const p = join(mkdtempSync(join(tmpdir(), "smoke-")), "s.json");
    writeFileSync(p, "{}");
    await expect(loadSmokeEval(p)).rejects.toThrow();
  });
});

describe("hardened bundle reads", () => {
  const tmp = (): string => mkdtempSync(join(tmpdir(), "ds-parse-"));

  it("loadSmokeEval rejects a symlink, a FIFO and an oversize file", async () => {
    const dir = tmp();
    const target = join(dir, "target.json");
    writeFileSync(target, "{}");
    symlinkSync(target, join(dir, "link.json"));
    await expect(loadSmokeEval(join(dir, "link.json"))).rejects.toThrow(/regular file/);
    execFileSync("mkfifo", [join(dir, "fifo.json")]);
    await expect(loadSmokeEval(join(dir, "fifo.json"))).rejects.toThrow(/regular file/);
    writeFileSync(join(dir, "big.json"), "x".repeat(MAX_SMOKE_BYTES + 1));
    await expect(loadSmokeEval(join(dir, "big.json"))).rejects.toThrow(/exceeds/);
  });

  it("parseSkillBundle rejects a FIFO SKILL.md without blocking", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "s"));
    execFileSync("mkfifo", [join(dir, "s", "SKILL.md")]);
    await expect(parseSkillBundle(dir)).rejects.toThrow(BundleError);
  });
});
