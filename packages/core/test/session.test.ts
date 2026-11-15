import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdtemp, rm, stat, symlink, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SessionStore,
  UnsafeHomeError,
  enforceDeadline,
  ensurePrivateDir,
  recordStage,
  resolveHome,
} from "../src/index";

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

  it("new sessions carry schemaVersion '1', empty requirements, null sufficiency and zeroed context counters", async () => {
    const s = await store.create(init);
    expect(s.schemaVersion).toBe("1");
    expect(s.requirements).toEqual([]);
    expect(s.sufficiency).toBeNull();
    expect(s.metrics).toMatchObject({
      contextRequests: 0,
      contextRequestRounds: 0,
      analysisSubmissions: 0,
      packetTokens: 0,
      analysisStartedAtActiveMs: null,
    });
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

describe("malformed session ids", () => {
  it.each(["..", "../x", "../../etc", "ds-x", "", "ds-20260101000000-ABCDEF"])(
    "reject %j with SESSION_NOT_FOUND and touch nothing outside sessions/",
    async (bad) => {
      const sentinel = join(home, "sentinel.txt");
      await writeFile(sentinel, "keep");
      const nf = { code: "SESSION_NOT_FOUND" };
      await expect(store.remove(bad)).rejects.toMatchObject(nf);
      await expect(store.load(bad)).rejects.toMatchObject(nf);
      await expect(store.withLock(bad, async () => 1)).rejects.toMatchObject(nf);
      expect(existsSync(sentinel)).toBe(true);
      expect(existsSync(join(home, "sessions"))).toBe(false);
    },
  );
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

describe("private session home (I3)", () => {
  const mode = async (p: string) => (await stat(p)).mode & 0o777;

  it("defaults to a per-user directory under the OS temp dir", () => {
    const prev = process.env.DYNAMIC_SKILLS_HOME;
    delete process.env.DYNAMIC_SKILLS_HOME;
    try {
      expect(resolveHome()).toBe(join(tmpdir(), `dynamic-skills-${process.getuid?.() ?? "user"}`));
    } finally {
      if (prev !== undefined) process.env.DYNAMIC_SKILLS_HOME = prev;
    }
  });

  it("creates the home, sessions/, session and artifact dirs 0700 and files 0600", async () => {
    const fresh = join(home, "nested", "home");
    const s = await new SessionStore(fresh).create(init);
    const st = new SessionStore(fresh);
    await st.writeArtifact(s.id, "reports/performance.json", "{}");
    const dir = join(fresh, "sessions", s.id);
    expect(await mode(fresh)).toBe(0o700);
    expect(await mode(join(fresh, "sessions"))).toBe(0o700);
    expect(await mode(dir)).toBe(0o700);
    expect(await mode(join(dir, "reports"))).toBe(0o700);
    expect(await mode(join(dir, "session.json"))).toBe(0o600);
    expect(await mode(join(dir, "reports/performance.json"))).toBe(0o600);
  });

  it("tightens an existing home and sessions/ that grant group or other access", async () => {
    await mkdir(join(home, "sessions"), { recursive: true });
    await chmod(home, 0o755);
    await chmod(join(home, "sessions"), 0o777);
    await store.create(init);
    expect(await mode(home)).toBe(0o700);
    expect(await mode(join(home, "sessions"))).toBe(0o700);
  });

  it("refuses a symlinked home, a symlinked sessions/ and a home that is a file", async () => {
    const real = join(home, "real");
    await mkdir(real);
    await symlink(real, join(home, "link"));
    await expect(new SessionStore(join(home, "link")).create(init)).rejects.toMatchObject({
      code: "HOME_UNSAFE",
    });
    await writeFile(join(home, "file"), "x");
    await expect(new SessionStore(join(home, "file")).create(init)).rejects.toMatchObject({
      code: "HOME_UNSAFE",
    });
    const h2 = join(home, "h2");
    await mkdir(h2);
    await symlink(real, join(h2, "sessions"));
    await expect(new SessionStore(h2).create(init)).rejects.toBeInstanceOf(UnsafeHomeError);
    expect(readdirSync(real)).toEqual([]);
  });

  it("refuses a directory owned by another user (injected stat)", async () => {
    const chmodCalls: string[] = [];
    const probe = {
      lstat: async () => ({
        isSymbolicLink: () => false,
        isDirectory: () => true,
        uid: 4242,
        mode: 0o40700,
      }),
      chmod: async (p: string) => {
        chmodCalls.push(p);
      },
      getuid: () => 1000,
    };
    await expect(ensurePrivateDir(home, probe)).rejects.toMatchObject({ code: "HOME_UNSAFE" });
    await expect(ensurePrivateDir(home, { ...probe, getuid: () => 4242 })).resolves.toBeUndefined();
    expect(chmodCalls).toEqual([]);
  });

  it("checks the home before a lock is taken on an existing session", async () => {
    const s = await store.create(init);
    await chmod(home, 0o750);
    // A new store, as in a new CLI process: each process checks the home once.
    await new SessionStore(home).withLock(s.id, async () => undefined);
    expect(await mode(home)).toBe(0o700);
  });
});
