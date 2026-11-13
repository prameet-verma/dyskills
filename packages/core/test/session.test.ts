import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore, enforceDeadline, recordStage, resolveHome } from "../src/index.js";

let home: string;
let store: SessionStore;
const init = {
  task: "t",
  mode: "auto",
  explicit: false,
  repo: "/r",
  revision: "untracked",
} as const;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ds-test-"));
  store = new SessionStore(home);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("SessionStore", () => {
  it("creates a session dir with a well-formed id", async () => {
    const s = await store.create({ ...init, now: 0 });
    expect(s.id).toMatch(/^ds-\d{14}-[0-9a-f]{6}$/);
    expect(existsSync(join(home, "sessions", s.id, "session.json"))).toBe(true);
    expect(s.status).toBe("assessing");
    expect(s.metrics.wallStartedAt).toBe(0);
    expect(await store.load(s.id)).toEqual(s);
  });

  it("throws SESSION_NOT_FOUND for unknown ids", async () => {
    await expect(store.load("ds-x")).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });

  it("rejects a corrupt session.json", async () => {
    const s = await store.create(init);
    await writeFile(join(store.dir(s.id), "session.json"), '{"id":1}');
    await expect(store.load(s.id)).rejects.toThrow();
  });

  it("rejects a concurrent withLock and releases the lock afterwards", async () => {
    const s = await store.create(init);
    let inner: unknown;
    await store.withLock(s.id, async () => {
      inner = await store.withLock(s.id, async () => 1).catch((e: unknown) => e);
    });
    expect(inner).toMatchObject({ code: "SESSION_LOCKED" });
    await expect(store.withLock(s.id, async () => "ok")).resolves.toBe("ok");
    expect(existsSync(join(store.dir(s.id), "session.lock"))).toBe(false);
  });

  it("removes the lock when fn throws", async () => {
    const s = await store.create(init);
    await expect(
      store.withLock(s.id, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(join(store.dir(s.id), "session.lock"))).toBe(false);
  });

  it("reclaims a lock older than 30s", async () => {
    const s = await store.create(init);
    const lock = join(store.dir(s.id), "session.lock");
    await writeFile(lock, "");
    const old = new Date(Date.now() - 31_000);
    await utimes(lock, old, old);
    await expect(store.withLock(s.id, async () => "ok")).resolves.toBe("ok");
  });

  it("leaves no .tmp file after save", async () => {
    const s = await store.create(init);
    s.status = "generating";
    await store.save(s);
    expect(readdirSync(store.dir(s.id)).some((f) => f.endsWith(".tmp"))).toBe(false);
    expect((await store.load(s.id)).status).toBe("generating");
  });

  it("writes and reads artifacts inside the session dir", async () => {
    const s = await store.create(init);
    const p = await store.writeArtifact(s.id, "skills/x/SKILL.md", "hi");
    expect(p).toBe(join(store.dir(s.id), "skills", "x", "SKILL.md"));
    expect(await store.readArtifact(s.id, "skills/x/SKILL.md")).toBe("hi");
    expect(await store.readArtifact(s.id, "missing.md")).toBeNull();
    await expect(store.writeArtifact(s.id, "../escape", "x")).rejects.toThrow();
  });

  it("removes a session", async () => {
    const s = await store.create(init);
    await store.remove(s.id);
    expect(existsSync(store.dir(s.id))).toBe(false);
    await mkdir(home, { recursive: true });
  });
});

describe("resolveHome", () => {
  it("honours DYNAMIC_SKILLS_HOME", () => {
    const prev = process.env.DYNAMIC_SKILLS_HOME;
    process.env.DYNAMIC_SKILLS_HOME = "/x/y";
    expect(resolveHome()).toBe("/x/y");
    if (prev === undefined) delete process.env.DYNAMIC_SKILLS_HOME;
    else process.env.DYNAMIC_SKILLS_HOME = prev;
  });
});

describe("recordStage / enforceDeadline", () => {
  it("accumulates stage time", async () => {
    const s = await store.create(init);
    recordStage(s, "discovery", 10);
    recordStage(s, "discovery", 5);
    expect(s.metrics.stageMs.discovery).toBe(15);
  });

  it("enforceDeadline marks timeout at 60s active", async () => {
    const s = await store.create({ ...init, now: 0 });
    expect(enforceDeadline(s, 59_999)).toBe(false);
    expect(s.status).toBe("assessing");
    expect(enforceDeadline(s, 60_000)).toBe(true);
    expect(s.status).toBe("timeout");
    expect(s.metrics.outcome).toBe("timeout");
  });
});
