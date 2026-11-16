import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NATIVE_PLACEMENT_TTL_MS,
  SessionStore,
  readNativeReferences,
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

describe("selectExpiredPlacements", () => {
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
    const bad = join(home, "sessions", "ds-bad");
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
    expect(await readNativeReferences(home)).toEqual({ byDir: new Map(), unparsable: 0 });
  });
});
