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

const list = (orders as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)
  .listOrdersByStatus!;

function need() {
  if (typeof list !== "function") throw new Error("listOrdersByStatus is not exported from the entry point");
}

async function setup() {
  need();
  const { db, clock } = createTestDb();
  const ctx = { db };
  const ids: string[] = [];
  for (const sku of ["a", "b", "c"]) {
    clock.advance(1000);
    const created = await outcome(() => orders.createOrder(ctx, { items: [{ sku, quantity: 1 }] }));
    if (!created.ok) throw new Error("fixture createOrder failed");
    ids.push(created.value.id as string);
  }
  await db.transaction(async (tx) => tx.update("orders", ids[1]!, { status: "paid" }));
  return { db, ctx, ids };
}

const idsOf = (value: unknown) => (value as { id: string }[]).map((o) => o.id);

describe("g3: listOrdersByStatus", () => {
  it("is exported from the package entry point", () => {
    expect(typeof list).toBe("function");
  });

  it("returns the matching orders in creation order", async () => {
    const { ctx, ids } = await setup();
    const pending = await outcome(() => list(ctx, "pending"));
    expect(pending.ok).toBe(true);
    if (pending.ok) {
      expect(Array.isArray(pending.value)).toBe(true);
      expect(idsOf(pending.value)).toEqual([ids[0], ids[2]]);
      expect((pending.value as { status: string }[]).every((o) => o.status === "pending")).toBe(true);
    }
    const paid = await outcome(() => list(ctx, "paid"));
    if (paid.ok) expect(idsOf(paid.value)).toEqual([ids[1]]);
    expect(paid.ok).toBe(true);
  });

  it("returns an empty list when nothing matches", async () => {
    const { ctx } = await setup();
    const none = await outcome(() => list(ctx, "cancelled"));
    expect(none.ok).toBe(true);
    if (none.ok) expect(none.value).toEqual([]);
  });

  it("fails for a status that is not a valid order status", async () => {
    const { ctx } = await setup();
    expect((await outcome(() => list(ctx, "bogus"))).ok).toBe(false);
  });

  it("is a pure query: it announces nothing and changes nothing", async () => {
    const { db, ctx, ids } = await setup();
    await drainOutbox(db);
    await outcome(() => list(ctx, "pending"));
    expect(await drainOutbox(db)).toEqual([]);
    expect(((await db.get("orders", ids[0]!)) as { version: number }).version).toBe(1);
  });
});
