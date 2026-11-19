import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NATIVE_PLACEMENT_TTL_MS,
  SessionStore,
  readNativeReferences,
  NATIVE_FUTURE_SKEW_MS,
  selectExpiredPlacements,
  type NativeReference,
} from "../src/index";

const T = 1_800_000_000_000;
const H = 3_600_000;
const ref = (placedAt: number, outcome: NativeReference["outcome"]): NativeReference => ({
  sessionId: "s",
  placedAt,
  outcome,
});
const run = (p: { mtimeMs: number }, refs: NativeReference[], unparsable = 0): string[] =>
  selectExpiredPlacements({
    placements: [{ dir: "/n/a", mtimeMs: p.mtimeMs }],
    refs: refs.length ? new Map([["/n/a", refs]]) : new Map(),
    unparsable,
    now: T,
  });

const tmps: string[] = [];
afterEach(async () => {
  await Promise.all(tmps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("selectExpiredPlacements", () => {
  it("keeps a placement exactly at the TTL boundary", () =>
    expect(run({ mtimeMs: T - NATIVE_PLACEMENT_TTL_MS }, [], 1)).toEqual([]));
  it("keeps a placement exactly at a custom TTL boundary", () =>
    expect(
      selectExpiredPlacements({
        placements: [{ dir: "/n/a", mtimeMs: T - 1000 }],
        refs: new Map(),
        unparsable: 1,
        now: T,
        ttlMs: 1000,
      }),
    ).toEqual([]));
  it("lets the TTL remove an unreferenced placement with a far-future mtime", () =>
    expect(run({ mtimeMs: T + 5 * H }, [], 1)).toEqual(["/n/a"]));
  it("tolerates small clock skew on an unreferenced placement", () =>
    expect(run({ mtimeMs: T + 60_000 }, [], 1)).toEqual([]));
  it("applies the future rule to a referenced placement's placedAt too", () =>
    expect(run({ mtimeMs: 0 }, [ref(T + 2 * H, "activated")])).toEqual(["/n/a"]));
  it("exports the future-skew tolerance (1 h)", () => expect(NATIVE_FUTURE_SKEW_MS).toBe(H));
  it("TTL is 24 hours", () => expect(NATIVE_PLACEMENT_TTL_MS).toBe(24 * H));
  it("keeps a fresh activated placement", () =>
    expect(run({ mtimeMs: 0 }, [ref(T - H, "activated")])).toEqual([]));
  it("expires an old activated placement", () =>
    expect(run({ mtimeMs: 0 }, [ref(T - 25 * H, "activated")])).toEqual(["/n/a"]));
  it("expires an unreferenced placement", () =>
    expect(run({ mtimeMs: T - H }, [])).toEqual(["/n/a"]));
  it("keeps an unreferenced placement while a session is unparsable", () =>
    expect(run({ mtimeMs: T - H }, [], 1)).toEqual([]));
  it("expires an old unreferenced placement despite unparsable", () =>
    expect(run({ mtimeMs: T - 25 * H }, [], 1)).toEqual(["/n/a"]));
  it("keeps a fresh augmented placement", () =>
    expect(run({ mtimeMs: 0 }, [ref(T - H, "augmented")])).toEqual([]));
  it("expires when every reference failed", () =>
    expect(run({ mtimeMs: 0 }, [ref(T - H, "failed"), ref(T - 2 * H, "timeout")])).toEqual([
      "/n/a",
    ]));
  it("keeps when one reference has no outcome yet", () =>
    expect(run({ mtimeMs: 0 }, [ref(T - H, "failed"), ref(T - H, undefined)])).toEqual([]));
  it("keeps when one reference succeeded", () =>
    expect(run({ mtimeMs: 0 }, [ref(T - H, "failed"), ref(T - H, "activated")])).toEqual([]));
  it("age starts at the newest placedAt", () =>
    expect(run({ mtimeMs: 0 }, [ref(T - 30 * H, "activated"), ref(T - H, "activated")])).toEqual(
      [],
    ));
  it("honours a custom ttl", () =>
    expect(
      selectExpiredPlacements({
        placements: [{ dir: "/n/a", mtimeMs: T - 2000 }],
        refs: new Map(),
        unparsable: 1,
        now: T,
        ttlMs: 1000,
      }),
    ).toEqual(["/n/a"]));
});

describe("readNativeReferences", () => {
  it("collects references, counts unparsable and honours exclude", async () => {
    const home = await mkdtemp(join(tmpdir(), "ds-nat-"));
    tmps.push(home);
    const store = new SessionStore(home);
    const base = { task: "t", mode: "auto", explicit: false, repo: "/r", revision: "x" } as const;
    const a = await store.create(base);
    const b = await store.create(base);
    const placedAt = new Date(T).toISOString();
    await writeFile(
      join(store.dir(a.id), "session.json"),
      JSON.stringify({
        ...a,
        metrics: { ...a.metrics, outcome: "activated" },
        native: {
          harness: "claude-code",
          dir: "/n/skill",
          manifestSha256: "a".repeat(64),
          placedAt,
        },
      }),
    );
    void b;
    const bad = join(home, "sessions", "ds-20260101000000-abcdef");
    await mkdir(bad, { recursive: true });
    await writeFile(join(bad, "session.json"), "{not json");

    const r = await readNativeReferences(home);
    expect(r.unparsable).toBe(1);
    expect(r.byDir.get("/n/skill")).toEqual([
      { sessionId: a.id, placedAt: T, outcome: "activated" },
    ]);

    const ex = await readNativeReferences(home, { exclude: a.id });
    expect(ex.byDir.size).toBe(0);
    expect(ex.unparsable).toBe(1);
  });

  it("returns nothing when there is no sessions directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "ds-nat-"));
    tmps.push(home);
    expect(await readNativeReferences(home)).toEqual({ byDir: new Map(), unparsable: 0 });
  });

  it("ignores stray entries and non-session names", async () => {
    const home = await mkdtemp(join(tmpdir(), "ds-nat-"));
    tmps.push(home);
    await mkdir(join(home, "sessions"), { recursive: true });
    await writeFile(join(home, "sessions", ".DS_Store"), "x");
    await mkdir(join(home, "sessions", "not-a-session"));
    await writeFile(join(home, "sessions", "ds-20260101000000-abcdef"), "a file, not a dir");
    expect((await readNativeReferences(home)).unparsable).toBe(0);
  });

  it("counts a real session dir without session.json as unparsable", async () => {
    const home = await mkdtemp(join(tmpdir(), "ds-nat-"));
    tmps.push(home);
    await mkdir(join(home, "sessions", "ds-20260101000000-abcdef"), { recursive: true });
    expect((await readNativeReferences(home)).unparsable).toBe(1);
  });

  /** A valid session.json carrying a native record, as a real session would write. */
  async function validSessionJson(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "ds-nat-src-"));
    tmps.push(home);
    const s = await new SessionStore(home).create({
      task: "t",
      mode: "auto",
      explicit: false,
      repo: "/r",
      revision: "x",
    });
    return JSON.stringify({
      ...s,
      metrics: { ...s.metrics, outcome: "activated" },
      native: {
        harness: "claude-code",
        dir: "/n/skill",
        manifestSha256: "a".repeat(64),
        placedAt: new Date(T).toISOString(),
      },
    });
  }

  it("counts a symlinked session dir as unparsable", async () => {
    const home = await mkdtemp(join(tmpdir(), "ds-nat-"));
    tmps.push(home);
    const real = await mkdtemp(join(tmpdir(), "ds-nat-real-"));
    tmps.push(real);
    await writeFile(join(real, "session.json"), await validSessionJson());
    await mkdir(join(home, "sessions"), { recursive: true });
    await symlink(real, join(home, "sessions", "ds-20260101000000-abcdef"));
    const r = await readNativeReferences(home);
    expect(r.byDir.size).toBe(0);
    expect(r.unparsable).toBe(1);
  });

  it("counts a symlinked session.json as unparsable", async () => {
    const home = await mkdtemp(join(tmpdir(), "ds-nat-"));
    tmps.push(home);
    const elsewhere = await mkdtemp(join(tmpdir(), "ds-nat-else-"));
    tmps.push(elsewhere);
    await writeFile(join(elsewhere, "session.json"), await validSessionJson());
    const dir = join(home, "sessions", "ds-20260101000000-abcdef");
    await mkdir(dir, { recursive: true });
    await symlink(join(elsewhere, "session.json"), join(dir, "session.json"));
    const r = await readNativeReferences(home);
    expect(r.byDir.size).toBe(0);
    expect(r.unparsable).toBe(1);
  });
});

describe("selectExpiredPlacements future placedAt", () => {
  it("expires a referenced placement whose newest placedAt is more than 1 h ahead", () =>
    expect(run({ mtimeMs: T }, [ref(T + 10 * H, "activated")], 1)).toEqual(["/n/a"]));
  it("keeps one whose placedAt is within the skew", () =>
    expect(run({ mtimeMs: T }, [ref(T + H / 2, "activated")])).toEqual([]));
});

describe("selectExpiredPlacements mixed references", () => {
  it("keeps a placement another session still uses when one placedAt is far-future", () =>
    expect(run({ mtimeMs: T }, [ref(T + 10 * H, "activated"), ref(T - H, "activated")])).toEqual(
      [],
    ));
  it("expires it when every reference is far-future", () =>
    expect(
      run({ mtimeMs: T }, [ref(T + 10 * H, "activated"), ref(T + 20 * H, "activated")]),
    ).toEqual(["/n/a"]));
});

describe("selectExpiredPlacements far-future live ref with a failed ref", () => {
  it("expires a placement whose only valid reference failed", () =>
    expect(run({ mtimeMs: T }, [ref(T + 10 * H, "activated"), ref(T - H, "failed")])).toEqual([
      "/n/a",
    ]));
});
