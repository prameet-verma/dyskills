import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "jsonc-parser";
import { ANALYST_INSTRUCTIONS } from "../analyst";
import { bundleManifest, findSaveConflicts, placeBundle } from "../bundle";
import { applyPlan, previewPlan } from "../apply";
import { jsonEqual } from "../json-merge";
import { isInside } from "../paths";
import type {
  HarnessAdapter,
  InstallPlan,
  InstallScope,
  JsonObject,
  JsonValue,
  NativeQuestionInput,
  PlannedWrite,
} from "../types";
import {
  makeWorld,
  readBootstrap,
  readTree,
  SAVE_FIXTURE,
  SAVE_FIXTURE_NAME,
  treeHash,
  type World,
} from "./fixtures";

/** What an adapter hands to {@link defineAdapterCompatSuite}. */
export interface CompatTarget {
  /** Suite name. */
  name: string;
  /** The adapter under test. */
  adapter: HarnessAdapter;
  /** Absolute fixture home; copied to `<tmp>/home` per case. */
  fixtureHome: string;
  /** Fake probe stdout for `<binary> --version`. */
  versionOutput: string;
  /** Extra environment variables; `{home}` and `{session}` are replaced by the tmp paths. */
  vars?: Record<string, string>;
  /** Lists the skills the harness would find. */
  scan: (o: {
    repo: string;
    home: string;
    vars: Record<string, string | undefined>;
    etcDir: string;
  }) => Promise<{ skills: { name: string; path: string }[] }>;
  /**
   * Optional consent probe: after `init` has been applied to the world for `scope`, returns what
   * the harness would decide for `command` (a full command line such as
   * `dynamic-skills save --session x --scope project`): `"ask"` or `"prompt"` when the user is
   * asked, anything else (`"allow"`, `"deny"`, ...) otherwise. When set, the suite requires `save`
   * and `init` to resolve to ask/prompt in both scopes.
   */
  consent?: (o: { world: World; scope: InstallScope; command: string }) => Promise<string>;
  /** What the adapter must report. */
  expect: {
    version: string;
    variant: string | null;
    questionTool: string;
    maxPerCall: number;
    maxOptions: number;
    multiSelect: boolean;
    nativeActivation: boolean;
    writesSessionHome: { personal: boolean; project: boolean };
  };
}

const SCOPES: InstallScope[] = ["personal", "project"];
const CASE_TIMEOUT = 60_000;
const BOOTSTRAP_NAME = "dynamic-skill-bootstrap";

async function withWorld(t: CompatTarget, fn: (w: World) => Promise<void>, withBinary = true) {
  const w = await makeWorld({
    fixtureHome: t.fixtureHome,
    vars: t.vars,
    versionOutput: t.versionOutput,
    adapter: t.adapter,
    withBinary,
  });
  try {
    await fn(w);
  } finally {
    await w.cleanup();
  }
}

async function planFor(t: CompatTarget, w: World, scope: InstallScope): Promise<InstallPlan> {
  const detection = await t.adapter.detect(w.env);
  return t.adapter.planInstall(w.env, detection, {
    scope,
    native: false,
    allowRule: false,
    bootstrapSkill: await readBootstrap(),
  });
}

const textOf = (w: PlannedWrite): string =>
  w.kind === "file" ? w.content.toString("utf8") : w.kind === "dir" ? "" : JSON.stringify(w.patch);

const bootstrapWrite = (plan: InstallPlan, bytes: Buffer) =>
  plan.writes.find(
    (w): w is PlannedWrite & { kind: "file" } => w.kind === "file" && w.content.equals(bytes),
  );

async function worldHash(w: World): Promise<string[]> {
  return [await treeHash(w.home), await treeHash(w.project), await treeHash(w.sessionParent)];
}

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every leaf of a JSON value as (path, value); arrays are leaves. */
function leaves(v: JsonValue, path: string[] = []): { path: string[]; value: JsonValue }[] {
  if (isObject(v)) {
    const entries = Object.entries(v);
    if (entries.length === 0) return path.length > 0 ? [{ path, value: v }] : [];
    return entries.flatMap(([k, x]) => leaves(x, [...path, k]));
  }
  return [{ path, value: v }];
}

function at(v: JsonValue | undefined, path: string[]): JsonValue | undefined {
  let cur: JsonValue | undefined = v;
  for (const k of path) {
    if (!isObject(cur) || !Object.hasOwn(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

const parseDoc = (text: string): JsonValue =>
  parse(text, [], { allowTrailingComma: true }) as JsonValue;

/** Ids longer than any native header limit, so a header can never stand in for the id. */
const SAMPLE_ID = (key: string): string => `${key}-sample-identifier`;

function sampleQuestions(): NativeQuestionInput[] {
  const opts = (id: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      label: `${id}-option-${i + 1}`,
      description: `Choice ${i + 1} of ${id}`,
    }));
  return [
    { id: SAMPLE_ID("qa"), text: "Question A?", options: opts("qa", 2) },
    { id: SAMPLE_ID("qb"), text: "Question B?" },
    { id: SAMPLE_ID("qc"), text: "Question C?", multiSelect: true, options: opts("qc", 4) },
    ...["qd", "qe", "qf", "qg"].map((key) => ({
      id: SAMPLE_ID(key),
      text: `Question ${key.slice(1).toUpperCase()}?`,
      options: opts(key, 2),
    })),
  ];
}

/** Every plain object reachable in `v` (including `v`). */
function objectsIn(v: unknown, out: JsonObject[] = []): JsonObject[] {
  if (Array.isArray(v)) v.forEach((x) => objectsIn(x, out));
  else if (typeof v === "object" && v !== null) {
    out.push(v as JsonObject);
    Object.values(v).forEach((x) => objectsIn(x, out));
  }
  return out;
}

/** Every string reachable in `v`. */
function stringsIn(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringsIn(x, out));
  else if (typeof v === "object" && v !== null) Object.values(v).forEach((x) => stringsIn(x, out));
  return out;
}

/** Every array reachable in `v`. */
function arraysIn(v: unknown, out: unknown[][] = []): unknown[][] {
  if (Array.isArray(v)) {
    out.push(v);
    for (const x of v) arraysIn(x, out);
  } else if (typeof v === "object" && v !== null) {
    for (const x of Object.values(v)) arraysIn(x, out);
  }
  return out;
}

const labelOf = (x: unknown): string | null =>
  typeof x === "string"
    ? x
    : isObject(x as JsonValue) && typeof (x as JsonObject).label === "string"
      ? ((x as JsonObject).label as string)
      : null;

/** Number of questions a call carries: its `questions` array, else the native ids it mentions. */
function callSize(call: JsonObject, nativeIds: string[]): number {
  if (Array.isArray(call.questions)) return call.questions.length;
  const strings = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") strings.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object" && v !== null) Object.values(v).forEach(walk);
  };
  walk(call);
  return Math.max(1, nativeIds.filter((id) => strings.has(id)).length);
}

/**
 * Registers the adapter compatibility cases (13, plus the untested-version case and, when `consent` is set, the consent case) under `describe("adapter compat: <name>")`.
 * Call it from a test file. The cases build their own tmp worlds (home copy, project with `.git`,
 * a session home reached through a symlink alias, an etc dir) and a fake probe; nothing real is
 * read or written. Native-question payloads are inspected generically: a call's size is
 * `call.questions.length` when present, and option labels are found as arrays of strings or
 * `{ label }` objects.
 */
export function defineAdapterCompatSuite(t: CompatTarget): void {
  const { adapter } = t;
  describe(`adapter compat: ${t.name}`, () => {
    it("detects the pinned version", { timeout: CASE_TIMEOUT }, async () => {
      await withWorld(t, async (w) => {
        const d = await adapter.detect(w.env);
        expect(d.installed).toBe(true);
        expect(d.version).toBe(t.expect.version);
        expect(d.variant).toBe(t.expect.variant);
        expect(d.tested).toBe(true);
      });
      await withWorld(
        t,
        async (w) => {
          expect((await adapter.detect(w.env)).installed).toBe(false);
        },
        false,
      );
    });

    it("installs the bootstrap byte-identically", { timeout: CASE_TIMEOUT }, async () => {
      const bytes = await readBootstrap();
      for (const scope of SCOPES) {
        await withWorld(t, async (w) => {
          const plan = await planFor(t, w, scope);
          const wr = bootstrapWrite(plan, bytes);
          expect(wr, `${scope}: a file write with the bootstrap bytes`).toBeDefined();
          const roots = (await adapter.readRoots(w.env)).filter(
            (r) => r.scope === scope && r.readBy.includes(adapter.id),
          );
          expect(
            roots.some((r) => dirname(dirname(wr!.path)) === r.dir),
            `${scope}: ${wr!.path} lies in a root the harness reads`,
          ).toBe(true);
          const res = await applyPlan(plan, { dryRun: false, force: false });
          expect(res.some((r) => r.action === "conflict")).toBe(false);
          expect((await readFile(wr!.path)).equals(bytes)).toBe(true);
          const scanned = await t.scan({
            repo: w.project,
            home: w.home,
            vars: w.vars,
            etcDir: w.etcDir,
          });
          expect(scanned.skills.map((s) => s.name)).toContain(BOOTSTRAP_NAME);
        });
      }
    });

    it("init is idempotent", { timeout: CASE_TIMEOUT }, async () => {
      for (const scope of SCOPES) {
        await withWorld(t, async (w) => {
          const first = await applyPlan(await planFor(t, w, scope), {
            dryRun: false,
            force: false,
          });
          expect(first.some((r) => r.action === "conflict")).toBe(false);
          const second = await planFor(t, w, scope);
          const preview = await previewPlan(second, { force: false });
          expect(preview.every((r) => r.action === "unchanged")).toBe(true);
          const before = await worldHash(w);
          await applyPlan(second, { dryRun: false, force: false });
          expect(await worldHash(w)).toEqual(before);
        });
      }
    });

    it("dry run writes nothing", { timeout: CASE_TIMEOUT }, async () => {
      for (const scope of SCOPES) {
        await withWorld(t, async (w) => {
          const plan = await planFor(t, w, scope);
          const before = await worldHash(w);
          await applyPlan(plan, { dryRun: true, force: false });
          expect(await worldHash(w)).toEqual(before);
        });
      }
    });

    it("preserves user configuration", { timeout: CASE_TIMEOUT }, async () => {
      for (const scope of SCOPES) {
        await withWorld(t, async (w) => {
          const before = await readTree(w.home);
          const plan = await planFor(t, w, scope);
          const planned = new Set(plan.writes.map((x) => x.path));
          const priorDocs = new Map<string, string>();
          for (const wr of plan.writes) {
            if (wr.kind === "json-merge" || wr.kind === "jsonc-merge") {
              try {
                priorDocs.set(wr.path, await readFile(wr.path, "utf8"));
              } catch {
                /* a new file has no prior leaves */
              }
            }
          }
          const res = await applyPlan(plan, { dryRun: false, force: false });
          expect(res.some((r) => r.action === "conflict")).toBe(false);
          const after = await readTree(w.home);
          for (const [rel, bytes] of before) {
            if (planned.has(join(w.home, rel))) continue;
            expect(after.get(rel)?.equals(bytes), `${rel} is byte-identical`).toBe(true);
          }
          for (const wr of plan.writes) {
            const prior = priorDocs.get(wr.path);
            if (prior === undefined || (wr.kind !== "json-merge" && wr.kind !== "jsonc-merge"))
              continue;
            const now = parseDoc(await readFile(wr.path, "utf8"));
            for (const leaf of leaves(parseDoc(prior))) {
              const found = at(now, leaf.path);
              const promoted =
                wr.promote !== undefined &&
                wr.promote.paths.some(
                  (p) => p.length === leaf.path.length && p.every((k, i) => k === leaf.path[i]),
                ) &&
                isObject(found as JsonValue) &&
                jsonEqual((found as JsonObject)[wr.promote.key], leaf.value);
              if (Array.isArray(leaf.value)) {
                expect(
                  Array.isArray(found),
                  `${wr.path} ${leaf.path.join(".")} stays an array`,
                ).toBe(true);
                for (const item of leaf.value) {
                  expect((found as JsonValue[]).some((x) => jsonEqual(x, item))).toBe(true);
                }
              } else {
                expect(
                  promoted || jsonEqual(found, leaf.value),
                  `${wr.path}: leaf ${leaf.path.join(".")} is still present`,
                ).toBe(true);
              }
            }
          }
        });
      }
    });

    it("project install is committable", { timeout: CASE_TIMEOUT }, async () => {
      await withWorld(t, async (w) => {
        const plan = await planFor(t, w, "project");
        for (const wr of plan.writes.filter((x) => x.committable)) {
          const text = `${wr.path}\n${textOf(wr)}`;
          for (const machine of [w.sessionReal, w.sessionAlias, w.env.userHome]) {
            expect(text.includes(machine), `${wr.path} must not contain ${machine}`).toBe(false);
          }
        }
      });
    });

    it("refuses to overwrite a different bootstrap", { timeout: CASE_TIMEOUT }, async () => {
      const bytes = await readBootstrap();
      for (const scope of SCOPES) {
        await withWorld(t, async (w) => {
          const plan = await planFor(t, w, scope);
          const wr = bootstrapWrite(plan, bytes)!;
          await mkdir(dirname(wr.path), { recursive: true });
          await writeFile(wr.path, "someone else's bootstrap\n");
          const before = await worldHash(w);
          const res = await applyPlan(plan, { dryRun: false, force: false });
          expect(res.find((r) => r.path === wr.path)?.action).toBe("conflict");
          expect(await worldHash(w)).toEqual(before);
          const forced = await applyPlan(await planFor(t, w, scope), {
            dryRun: false,
            force: true,
          });
          expect(forced.find((r) => r.path === wr.path)?.action).toBe("update");
          expect((await readFile(wr.path)).equals(bytes)).toBe(true);
        });
      }
    });

    it("writes real paths", { timeout: CASE_TIMEOUT }, async () => {
      for (const scope of SCOPES) {
        await withWorld(t, async (w) => {
          const plan = await planFor(t, w, scope);
          let mentionsSession = false;
          for (const wr of plan.writes) {
            const text = `${wr.path}\n${textOf(wr)}`;
            expect(text.includes(w.sessionAlias), `${wr.path} must not use the alias`).toBe(false);
            if (text.includes(w.sessionReal)) mentionsSession = true;
          }
          if (t.expect.writesSessionHome[scope]) {
            expect(mentionsSession, `${scope} plan contains the session home realpath`).toBe(true);
          }
        });
      }
    });

    it("saves a bundle byte-identically", { timeout: CASE_TIMEOUT }, async () => {
      const source = await bundleManifest(SAVE_FIXTURE);
      for (const scope of SCOPES) {
        await withWorld(t, async (w) => {
          const dest = adapter.skillRoot(w.env, scope);
          const input = {
            srcDir: SAVE_FIXTURE,
            destRoot: dest,
            name: SAVE_FIXTURE_NAME,
            mode: "save" as const,
            within: scope === "project" ? w.env.projectRoot : null,
          };
          const first = await placeBundle(input);
          expect(first.action).toBe("create");
          expect(first.manifest).toEqual(source);
          expect(await bundleManifest(first.path)).toEqual(source);
          const scanned = await t.scan({
            repo: w.project,
            home: w.home,
            vars: w.vars,
            etcDir: w.etcDir,
          });
          expect(scanned.skills.map((s) => s.name)).toContain(SAVE_FIXTURE_NAME);
          expect((await placeBundle(input)).action).toBe("unchanged");
        });
      }
    });

    it("refuses a same-name different skill", { timeout: CASE_TIMEOUT }, async () => {
      const source = await bundleManifest(SAVE_FIXTURE);
      for (const pick of ["first", "last"] as const) {
        await withWorld(t, async (w) => {
          const dirs = (await adapter.readRoots(w.env)).map((r) => r.dir);
          expect(dirs.length).toBeGreaterThan(0);
          const dir = pick === "first" ? dirs[0]! : dirs[dirs.length - 1]!;
          const seeded = join(dir, SAVE_FIXTURE_NAME);
          await mkdir(seeded, { recursive: true });
          await writeFile(
            join(seeded, "SKILL.md"),
            "---\nname: order-cache-specialist\n---\nDifferent.\n",
          );
          expect(
            await findSaveConflicts({
              name: SAVE_FIXTURE_NAME,
              manifestSha256: source.sha256,
              roots: dirs,
            }),
          ).toEqual([seeded]);
        });
      }
    });

    it("maps structured questions", { timeout: CASE_TIMEOUT }, () => {
      const qs = sampleQuestions();
      const plan = adapter.questions(qs);
      expect(plan.tool).toBe(t.expect.questionTool);
      expect(plan.textOnly).toContain(SAMPLE_ID("qb"));
      const cText = plan.textOnly.includes(SAMPLE_ID("qc"));
      expect(cText).toBe(!t.expect.multiSelect || 4 > t.expect.maxOptions);
      const nativeIds = Object.keys(plan.idMap);
      const mapped = Object.values(plan.idMap);
      const all = [...mapped, ...plan.textOnly].sort();
      expect(all).toEqual(qs.map((q) => q.id).sort());
      expect(new Set(mapped).size, "each question maps from exactly one native id").toBe(
        mapped.length,
      );
      expect(
        mapped.filter((id) => plan.textOnly.includes(id)),
        "no question is both native and text-only",
      ).toEqual([]);
      // Tie every idMap entry to the payload: the object that carries the native id as a value must
      // also carry the mapped question's text and its option labels, in order.
      for (const [nativeId, originalId] of Object.entries(plan.idMap)) {
        const q = qs.find((x) => x.id === originalId)!;
        const owner = objectsIn(plan.calls).find((o) =>
          Object.values(o).some((v) => v === nativeId),
        );
        expect(owner, `idMap key ${nativeId} is a value in a payload object`).toBeDefined();
        const strings = stringsIn(owner);
        expect(
          strings.some((x) => x.includes(q.text)),
          `${nativeId}: its payload object carries the text of ${originalId}`,
        ).toBe(true);
        const labels = q.options?.map((o) => o.label) ?? [];
        if (labels.length > 0) {
          expect(
            arraysIn(owner).some((arr) => {
              const got = arr.map(labelOf);
              return got.length === labels.length && got.every((l, i) => l === labels[i]);
            }),
            `${nativeId}: its payload object carries the option labels of ${originalId} in order`,
          ).toBe(true);
        }
      }
      let carried = 0;
      for (const call of plan.calls) {
        const size = callSize(call, nativeIds);
        expect(size).toBeLessThanOrEqual(t.expect.maxPerCall);
        carried += size;
      }
      expect(carried).toBe(mapped.length);
      const found = plan.calls.flatMap((c) => arraysIn(c)).map((a) => a.map(labelOf));
      for (const id of mapped) {
        const q = qs.find((x) => x.id === id)!;
        const labels = q.options?.map((o) => o.label) ?? [];
        expect(
          found.some((arr) => arr.length === labels.length && arr.every((l, i) => l === labels[i])),
          `${id}: every option label is kept, in order`,
        ).toBe(true);
      }
    });

    it("warns about an untested version", { timeout: CASE_TIMEOUT }, async () => {
      const output = t.versionOutput.replace(t.expect.version, "0.0.1");
      expect(output, "versionOutput contains the expected version").not.toBe(t.versionOutput);
      await withWorld({ ...t, versionOutput: output }, async (w) => {
        const d = await adapter.detect(w.env);
        expect(d.installed).toBe(true);
        expect(d.tested).toBe(false);
        expect(d.warnings.length).toBeGreaterThan(0);
      });
    });

    if (t.consent !== undefined) {
      const probe = t.consent;
      it("save and init resolve to ask", { timeout: CASE_TIMEOUT }, async () => {
        for (const scope of SCOPES) {
          await withWorld(t, async (w) => {
            const res = await applyPlan(await planFor(t, w, scope), {
              dryRun: false,
              force: false,
            });
            expect(res.some((r) => r.action === "conflict")).toBe(false);
            for (const command of [
              `dynamic-skills save --session x --scope project --harness ${adapter.id}`,
              `dynamic-skills init --harness ${adapter.id}`,
            ]) {
              const decision = await probe({ world: w, scope, command });
              expect(["ask", "prompt"], `${scope}: ${command} resolves to ${decision}`).toContain(
                decision,
              );
            }
          });
        }
      });
    }

    it("native activation root", { timeout: CASE_TIMEOUT }, async () => {
      expect(adapter.nativeActivation).toBe(t.expect.nativeActivation);
      await withWorld(t, async (w) => {
        const off = { ...w.env, vars: { ...w.env.vars, DYNAMIC_SKILLS_NATIVE: undefined } };
        expect(adapter.nativeSessionRoot(off)).toBeNull();
        const on = { ...w.env, vars: { ...w.env.vars, DYNAMIC_SKILLS_NATIVE: "1" } };
        const root = adapter.nativeSessionRoot(on);
        if (t.expect.nativeActivation) {
          expect(root).not.toBeNull();
          expect(isInside(root!, w.env.sessionHome)).toBe(true);
        } else {
          expect(root).toBeNull();
        }
      });
    });

    it("installs a read-only analyst", { timeout: CASE_TIMEOUT }, async () => {
      const sentence = ANALYST_INSTRUCTIONS.slice(0, ANALYST_INSTRUCTIONS.indexOf(".") + 1);
      expect(sentence.length).toBeGreaterThan(20);
      for (const scope of SCOPES) {
        await withWorld(t, async (w) => {
          const plan = await planFor(t, w, scope);
          const hits = plan.writes.filter(
            (wr) => wr.kind === "file" && wr.content.toString("utf8").includes(sentence),
          );
          expect(hits, `${scope}: one analyst write`).toHaveLength(1);
        });
      }
    });
  });
}
