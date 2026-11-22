import { describe, expect, it } from "vitest";
import { err, ok } from "@acme/result";
import { DeliveryFailed, type BusEvent, type Publisher } from "@acme/events";
import { createOutboxRelay } from "@acme/outbox";
import { createTestDb } from "@acme/testkit";
import * as orders from "./index";

// Behavioural spec: only the package's public functions and observable state are used. Events
// count the same whether they were published directly or drained from an outbox.

type Db = ReturnType<typeof createTestDb>["db"];
type Call = { ok: true; value: any } | { ok: false }; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Classify a call. A refusal is a throw, an `ok: false` / `success: false` result, an
 * error-only object, or null/undefined (the prompts say success returns the order or the list).
 */
async function call(fn: () => Promise<unknown>): Promise<Call> {
  try {
    const r = (await fn()) as Record<string, unknown> | null | undefined;
    if (r === null || r === undefined) return { ok: false };
    if (typeof r === "object" && typeof r.ok === "boolean") {
      return r.ok ? { ok: true, value: r.value } : { ok: false };
    }
    if (typeof r === "object" && typeof r.success === "boolean") {
      return r.success ? { ok: true, value: r.data ?? r.value ?? r } : { ok: false };
    }
    if (typeof r === "object" && !Array.isArray(r) && "error" in r && !("id" in r)) {
      return { ok: false };
    }
    return { ok: true, value: r };
  } catch {
    return { ok: false };
  }
}

function recorder() {
  const events: BusEvent[] = [];
  const state = { mode: "ok" as "ok" | "fail" | "throw" };
  const bus: Publisher = {
    async publish(event) {
      if (state.mode === "throw") throw new Error("publisher down");
      if (state.mode === "fail") return err(DeliveryFailed("publisher down", { topic: event.topic }));
      events.push(event);
      return ok(undefined);
    },
  };
  return { bus, events, state };
}
type Recorder = ReturnType<typeof recorder>;

/** Everything delivered so far matching `topic`: direct publishes plus a drain of any outbox. */
async function delivered(db: Db, rec: Recorder, topic: RegExp): Promise<BusEvent[]> {
  rec.state.mode = "ok";
  await createOutboxRelay(db).drain(rec.bus);
  return rec.events.filter((e) => topic.test(e.topic));
}

const rowOf = (db: Db, id: string) =>
  db.get("orders", id) as Promise<{ status: string; version: number; updatedAt: string; items: unknown[] }>;

async function freshOrder() {
  const { db, clock } = createTestDb();
  const rec = recorder();
  const ctx = { db, bus: rec.bus };
  const created = await call(() => orders.createOrder(ctx, { items: [{ sku: "a", quantity: 1 }] }));
  if (!created.ok) throw new Error("fixture createOrder failed");
  await delivered(db, rec, /./);
  rec.events.length = 0; // forget the creation event
  return { db, clock, rec, ctx, id: created.value.id as string };
}

const fn = (name: string) =>
  (orders as unknown as Record<string, ((...a: unknown[]) => Promise<unknown>) | undefined>)[name];
function need(name: string) {
  const f = fn(name);
  if (typeof f !== "function") throw new Error(`${name} is not exported from the package entry point`);
  return f;
}
const validTime = (iso: unknown) => typeof iso === "string" && !Number.isNaN(Date.parse(iso));

const CANCELLED = /cancel/i;
const cancel = (...a: unknown[]) => need("cancelOrder")(...a);

async function setup(status?: "paid") {
  need("cancelOrder");
  const o = await freshOrder();
  if (status) await o.db.transaction(async (tx) => tx.update("orders", o.id, { status }));
  return o;
}

describe("g2: cancelOrder", () => {
  it("is exported from the package entry point", () => {
    expect(typeof fn("cancelOrder")).toBe("function");
  });

  it("cancels a pending order, bumps the version, returns it and announces once", async () => {
    const { db, rec, ctx, id } = await setup();
    const before = await rowOf(db, id);
    const res = await call(() => cancel(ctx, id));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toMatchObject({ id, status: "cancelled", version: 2 });
    const stored = await rowOf(db, id);
    expect(stored).toMatchObject({ status: "cancelled", version: 2 });
    expect(validTime(stored.updatedAt)).toBe(true);
    const events = await delivered(db, rec, CANCELLED);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ id, version: 2 });
  });

  it("refuses a paid order without changing it or announcing", async () => {
    const { db, rec, ctx, id } = await setup("paid");
    await delivered(db, rec, /./);
    const before = await rowOf(db, id);
    expect((await call(() => cancel(ctx, id))).ok).toBe(false);
    expect(await rowOf(db, id)).toEqual(before);
    expect(await delivered(db, rec, CANCELLED)).toEqual([]);
  });

  it("refuses cancelling twice and an unknown order", async () => {
    const { db, rec, ctx, id } = await setup();
    expect((await call(() => cancel(ctx, id))).ok).toBe(true);
    await delivered(db, rec, CANCELLED);
    const before = await rowOf(db, id);
    expect((await call(() => cancel(ctx, id))).ok).toBe(false);
    expect((await call(() => cancel(ctx, "ord_missing"))).ok).toBe(false);
    expect(await rowOf(db, id)).toEqual(before);
    expect(await delivered(db, rec, CANCELLED)).toHaveLength(1);
  });

  it("yields exactly one cancellation for simultaneous cancels", async () => {
    const { db, ctx, id } = await setup();
    const results = await Promise.all([
      call(() => cancel(ctx, id)),
      call(() => cancel(ctx, id)),
      call(() => cancel(ctx, id)),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await rowOf(db, id)).version).toBe(2);
  });
});
