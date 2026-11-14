import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { MAX_CONTEXT_REQUEST_ROUNDS, type ContextRequest } from "@dynamic-skills/core";
import { describe, expect, it } from "vitest";
import { enrichContextPacket, measurePacket } from "../src/index";
import { buildFor, CACHING_TASK, put, tmpRepo } from "./helpers";

const req = (paths: string[]): ContextRequest => ({
  schemaVersion: "1",
  action: "request_context",
  requests: paths.map((path) => ({ type: "source_file" as const, path, reason: "need it" })),
});

async function setup() {
  const repo = await tmpRepo();
  await put(repo, ".git/config", "[core]");
  await put(repo, "config/.env.local", "S=1");
  await put(join(repo, ".."), "outside.txt", "outside");
  await symlink(".env", join(repo, "link.txt"));
  await symlink(".git/config", join(repo, "link-git"));
  const packet = await buildFor(repo, CACHING_TASK);
  return { repo, packet };
}

describe("enrichContextPacket", () => {
  it("rejects unsafe and redundant paths and adds the rest", async () => {
    const { repo, packet } = await setup();
    const before = JSON.stringify(packet);
    const r = await enrichContextPacket(
      packet,
      req([
        ".env",
        "config/.env.local",
        "link.txt",
        "../outside.txt",
        "/etc/hosts",
        ".git/config",
        "link-git",
        "node_modules/x/index.js",
        "missing.ts",
        "packages/orders/src/index.ts",
        "README.md",
        "./README.md",
      ]),
      { repo, roundsUsed: 0 },
    );
    expect(r.rejected.map((x) => x.reason)).toEqual([
      "secret",
      "secret",
      "secret",
      "outside-repo",
      "outside-repo",
      "excluded",
      "excluded",
      "excluded",
      "missing",
      "duplicate",
      "duplicate",
    ]);
    expect(r.added).toEqual(["README.md"]);
    expect(r.countsAsRound).toBe(true);
    expect(r.packet.packetRevision).toBe(2);
    expect(r.packet.relevantFiles.at(-1)).toMatchObject({
      path: "README.md",
      reason: "need it",
      addedInRevision: 2,
    });
    expect(r.packet.size).toEqual(measurePacket(r.packet));
    expect(packet.packetRevision).toBe(1);
    expect(JSON.stringify(packet)).toBe(before);
  });

  it("treats a symlink alias of a known file as a duplicate", async () => {
    const { repo, packet } = await setup();
    await symlink("packages/orders/src/index.ts", join(repo, "alias.ts"));
    await symlink("README.md", join(repo, "readme-link.md"));
    const first = await enrichContextPacket(packet, req(["README.md"]), { repo, roundsUsed: 0 });
    expect(first.added).toEqual(["README.md"]);
    const r = await enrichContextPacket(first.packet, req(["readme-link.md", "alias.ts"]), {
      repo,
      roundsUsed: 1,
    });
    expect(r.rejected).toEqual([
      { path: "readme-link.md", reason: "duplicate" },
      { path: "alias.ts", reason: "duplicate" },
    ]);
    expect(r.added).toEqual([]);
  });

  it("rejects everything after three rounds", async () => {
    const { repo, packet } = await setup();
    const r = await enrichContextPacket(packet, req(["README.md", "nx.json"]), {
      repo,
      roundsUsed: MAX_CONTEXT_REQUEST_ROUNDS,
    });
    expect(r.rejected.map((x) => x.reason)).toEqual(["round-limit", "round-limit"]);
    expect(r.countsAsRound).toBe(false);
    expect(r.added).toEqual([]);
    expect(r.packet).toBe(packet);
  });

  it("rejects files that would exceed the budget", async () => {
    const { repo, packet } = await setup();
    const budgetTokens = measurePacket(packet).estimatedTokens + 10;
    const r = await enrichContextPacket(packet, req(["README.md"]), {
      repo,
      roundsUsed: 0,
      budgetTokens,
    });
    expect(r.rejected).toEqual([{ path: "README.md", reason: "over-budget" }]);
    await put(repo, "big.ts", "z".repeat(5_000));
    const r2 = await enrichContextPacket(packet, req(["big.ts"]), {
      repo,
      roundsUsed: 0,
      budgetTokens,
    });
    expect(r2.rejected).toEqual([{ path: "big.ts", reason: "over-budget" }]);
    expect(r2.added).toEqual([]);
    expect(r2.packet.packetRevision).toBe(1);
  });
});
