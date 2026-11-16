import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return { ...real, randomBytes: () => Buffer.from("abcdef") };
});

import { applyPlan, PlanApplyError } from "../src/index";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "sdk-atomic-")));
  await mkdir(join(root, "p"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("temp file creation", () => {
  it("never writes through a pre-planted temp name (opened exclusively)", async () => {
    const p = join(root, "p");
    await writeFile(join(p, ".x.txt.tmp-616263646566"), "planted");
    const err = await applyPlan(
      {
        harness: "claude-code",
        scope: "project",
        projectRoot: p,
        notes: [],
        verify: [],
        writes: [
          {
            kind: "file",
            path: join(p, "x.txt"),
            content: Buffer.from("new"),
            committable: true,
            purpose: "t",
            within: p,
          },
        ],
      },
      { dryRun: false, force: false },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanApplyError);
    expect(await readFile(join(p, ".x.txt.tmp-616263646566"), "utf8")).toBe("planted");
  });
});
