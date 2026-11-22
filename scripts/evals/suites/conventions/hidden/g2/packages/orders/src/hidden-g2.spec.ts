import { describe, expect, it } from "vitest";
import { createTestDb, drainOutbox } from "@acme/testkit";
import * as orders from "./index";

type Outcome = { ok: true; value: any } | { ok: false };

/** Normalise a call: a returned ok/err value, a plain return, or a throw. Behaviour only. */
async function outcome(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    const r = (await fn()) as { ok?: unknown; value?: unknown } | undefined;
    if (r && typeof r === "object" && "ok" in r) {
      return r.ok ? { ok: true, value: r.value } : { ok: false };
    }
    return { ok: true, value: r };
  } catch {
    return { ok: false };
  }
}

const cancel = (orders as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)
  .cancelOrder!;
const CANCELLED = /^orders\.v\d+\.cancel(l)?ed$/;

function need() {
  if (typeof cancel !== "function") throw new Error("cancelOrder is not exported from the entry point");
}

async function setup(status?: "paid") {
  need();
  const { db, clock } = createTestDb();
  const ctx = { db };
  const created = await outcome(() =>
    orders.createOrder(ctx, { items: [{ sku: "a", quantity: 1 }] }),
  );
  if (!created.ok) throw new Error("fixture createOrder failed");
  const id = created.value.id as string;
  if (status) {
    await db.transaction(async (tx) => tx.update("orders", id, { status }));
  }
  await drainOutbox(db); // discard earlier events
  return { db, clock, ctx, id };
}

const row = (db: { get: (t: string, id: string) => Promise<unknown> }, id: string) =>
  db.get("orders", id) as Promise<{ status: string; version: number; updatedAt: string }>;

describe("g2: cancelOrder", () => {
  it("is exported from the package entry point", () => {
    expect(typeof cancel).toBe("function");
  });

  it("cancels a pending order, bumps the version, refreshes updatedAt and announces once", async () => {
    const { db, clock, ctx, id } = await setup();
    clock.advance(7000);
    const res = await outcome(() => cancel(ctx, id));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toMatchObject({ id, status: "cancelled", version: 2 });
    const stored = await row(db, id);
    expect(stored).toMatchObject({ status: "cancelled", version: 2, updatedAt: "2026-01-01T00:00:07.000Z" });
    const events = await drainOutbox(db);
    expect(events).toHaveLength(1);
    expect(CANCELLED.test(events[0]!.topic)).toBe(true);
    expect(events[0]!.payload).toMatchObject({ id, version: 2 });
    expect(typeof events[0]!.idempotencyKey).toBe("string");
    expect(events[0]!.idempotencyKey.length).toBeGreaterThan(0);
  });

  it("refuses a paid order without changing it or announcing", async () => {
    const { db, ctx, id } = await setup("paid");
    const before = await row(db, id);
    expect((await outcome(() => cancel(ctx, id))).ok).toBe(false);
    expect(await row(db, id)).toEqual(before);
    expect(await drainOutbox(db)).toEqual([]);
  });

  it("refuses cancelling twice and an unknown order", async () => {
    const { db, ctx, id } = await setup();
    expect((await outcome(() => cancel(ctx, id))).ok).toBe(true);
    await drainOutbox(db);
    const before = await row(db, id);
    expect((await outcome(() => cancel(ctx, id))).ok).toBe(false);
    expect((await outcome(() => cancel(ctx, "ord_missing"))).ok).toBe(false);
    expect(await row(db, id)).toEqual(before);
    expect(await drainOutbox(db)).toEqual([]);
  });

  it("yields exactly one cancellation and one event for simultaneous cancels", async () => {
    const { db, ctx, id } = await setup();
    const results = await Promise.all([
      outcome(() => cancel(ctx, id)),
      outcome(() => cancel(ctx, id)),
      outcome(() => cancel(ctx, id)),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await row(db, id)).version).toBe(2);
    expect(await drainOutbox(db)).toHaveLength(1);
  });
});
