import { describe, expect, it } from "vitest";
import { err, ok } from "@acme/result";
import { createDb, type Row } from "./index";

type Thing = Row & { name: string };

describe("db", () => {
  it("commits on ok and rolls back on err or throw", async () => {
    const db = createDb();
    await db.transaction(async (tx) => tx.insert<Thing>("things", { id: "a", name: "A" }));
    await db.transaction(async (tx) => {
      await tx.insert<Thing>("things", { id: "b", name: "B" });
      return err("nope");
    });
    await expect(
      db.transaction(async (tx) => {
        await tx.insert<Thing>("things", { id: "c", name: "C" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await db.list<Thing>("things")).map((t) => t.id)).toEqual(["a"]);
  });

  it("updateWhereVersion refuses a stale version and leaves the row alone", async () => {
    const db = createDb();
    await db.transaction(async (tx) => tx.insert<Thing>("things", { id: "a", name: "A" }));
    const stale = await db.transaction(async (tx) =>
      tx.updateWhereVersion<Thing>("things", "a", 7, { name: "X" }),
    );
    expect(stale).toEqual(
      err(expect.objectContaining({ kind: "VersionConflict", expected: 7, actual: 1 })),
    );
    const fresh = await db.transaction(async (tx) =>
      tx.updateWhereVersion<Thing>("things", "a", 1, { name: "X" }),
    );
    expect(fresh).toEqual(ok({ id: "a", name: "X", version: 2 }));
  });
});
