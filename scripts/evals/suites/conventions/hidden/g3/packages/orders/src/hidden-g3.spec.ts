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

const list = (...a: unknown[]) => need("listOrdersByStatus")(...a);

async function setup() {
  need("listOrdersByStatus");
  const { db, clock, rec, ctx } = await freshOrder(); // one pending order already exists
  const first = (await db.list<{ id: string }>("orders"))[0]!.id;
  const ids = [first];
  for (const sku of ["b", "c"]) {
    clock.advance(1000);
    const created = await call(() => orders.createOrder(ctx, { items: [{ sku, quantity: 1 }] }));
    if (!created.ok) throw new Error("fixture createOrder failed");
    ids.push(created.value.id as string);
  }
  await db.transaction(async (tx) => tx.update("orders", ids[1]!, { status: "paid" }));
  return { db, rec, ctx, ids };
}

const idsOf = (value: unknown) => (value as { id: string }[]).map((o) => o.id);

describe("g3: listOrdersByStatus", () => {
  it("is exported from the package entry point", () => {
    expect(typeof fn("listOrdersByStatus")).toBe("function");
  });

  it("returns the matching orders in creation order", async () => {
    const { ctx, ids } = await setup();
    const pending = await call(() => list(ctx, "pending"));
    expect(pending.ok).toBe(true);
    if (pending.ok) {
      expect(Array.isArray(pending.value)).toBe(true);
      expect(idsOf(pending.value)).toEqual([ids[0], ids[2]]);
      expect((pending.value as { status: string }[]).every((o) => o.status === "pending")).toBe(true);
    }
    const paid = await call(() => list(ctx, "paid"));
    expect(paid.ok).toBe(true);
    if (paid.ok) expect(idsOf(paid.value)).toEqual([ids[1]]);
  });

  it("returns an empty list when nothing matches", async () => {
    const { ctx } = await setup();
    const none = await call(() => list(ctx, "cancelled"));
    expect(none.ok).toBe(true);
    if (none.ok) expect(none.value).toEqual([]);
  });

  it("refuses a status that is not a valid order status", async () => {
    const { ctx } = await setup();
    expect((await call(() => list(ctx, "bogus"))).ok).toBe(false);
  });

  it("is a pure query: it announces nothing and changes nothing", async () => {
    const { db, rec, ctx, ids } = await setup();
    await delivered(db, rec, /./);
    rec.events.length = 0;
    await call(() => list(ctx, "pending"));
    expect(await delivered(db, rec, /./)).toEqual([]);
    expect(((await db.get("orders", ids[0]!)) as { version: number }).version).toBe(1);
  });
});
