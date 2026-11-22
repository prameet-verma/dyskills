import { err, ok, type Result } from "@acme/result";
import { defineError, type DomainError } from "@acme/errors";

/** Every stored row has a string id and an integer version (1 on insert, +1 per update). */
export type Row = { id: string; version: number };
export type Clock = { now(): Date };

export const VersionConflict = defineError("VersionConflict");
export type VersionConflict = DomainError<
  "VersionConflict",
  { expected: number; actual: number | null }
>;
export const DuplicateRow = defineError("DuplicateRow");
export type DuplicateRow = DomainError<"DuplicateRow", { table: string; id: string }>;
export type DbError = VersionConflict | DuplicateRow;

export interface Reader {
  get<R extends Row>(table: string, id: string): Promise<R | undefined>;
  /** Rows in insertion order. */
  list<R extends Row>(table: string): Promise<R[]>;
}

export interface Tx extends Reader {
  now(): Date;
  /** Stores the row with version 1; pass the row without a version. */
  insert<R extends Row>(table: string, row: Omit<R, "version">): Promise<Result<R, DuplicateRow>>;
  /**
   * Optimistic concurrency: applies the patch and bumps the version only if the stored version
   * equals `expectedVersion`; otherwise returns a VersionConflict and changes nothing.
   */
  updateWhereVersion<R extends Row>(
    table: string,
    id: string,
    expectedVersion: number,
    patch: Partial<Omit<R, "id" | "version">>,
  ): Promise<Result<R, VersionConflict>>;
  /** Unconditional last-write-wins update (bumps the version). For tests and migrations only. */
  update<R extends Row>(
    table: string,
    id: string,
    patch: Partial<Omit<R, "id" | "version">>,
  ): Promise<Result<R, VersionConflict>>;
}

export interface Db extends Reader {
  now(): Date;
  /**
   * Runs `fn` atomically. Commits when it returns an ok Result; rolls back when it returns an err
   * Result or throws (a throw is then re-thrown). Transactions run one at a time; do not nest.
   */
  transaction<T, E>(fn: (tx: Tx) => Promise<Result<T, E>>): Promise<Result<T, E>>;
}

type Tables = Map<string, Map<string, Row>>;

function cloneTables(tables: Tables): Tables {
  return new Map(
    [...tables].map(([name, rows]) => [
      name,
      new Map([...rows].map(([id, row]) => [id, structuredClone(row)])),
    ]),
  );
}

export function createDb(options: { clock?: Clock } = {}): Db {
  const clock = options.clock ?? { now: () => new Date() };
  let committed: Tables = new Map();
  let tail: Promise<unknown> = Promise.resolve();

  const readFrom = (tables: () => Tables): Reader => ({
    async get<R extends Row>(table: string, id: string) {
      const row = tables().get(table)?.get(id);
      return row === undefined ? undefined : (structuredClone(row) as R);
    },
    async list<R extends Row>(table: string) {
      return [...(tables().get(table)?.values() ?? [])].map((row) => structuredClone(row) as R);
    },
  });

  function makeTx(work: Tables): Tx {
    const rows = (table: string) => {
      if (!work.has(table)) work.set(table, new Map());
      return work.get(table) as Map<string, Row>;
    };
    async function apply<R extends Row>(
      table: string,
      id: string,
      expected: number | undefined,
      patch: Partial<Omit<R, "id" | "version">>,
    ): Promise<Result<R, VersionConflict>> {
      const current = rows(table).get(id);
      if (current === undefined || (expected !== undefined && current.version !== expected)) {
        return err(
          VersionConflict(`version conflict on ${table}/${id}`, {
            expected: expected ?? -1,
            actual: current?.version ?? null,
          }),
        );
      }
      const next = { ...current, ...patch, id, version: current.version + 1 } as R;
      rows(table).set(id, next);
      return ok(structuredClone(next));
    }
    return {
      ...readFrom(() => work),
      now: () => clock.now(),
      async insert<R extends Row>(table: string, row: Omit<R, "version">) {
        const id = (row as { id: string }).id;
        if (rows(table).has(id)) {
          return err(DuplicateRow(`duplicate row ${table}/${id}`, { table, id }));
        }
        const stored = { ...row, version: 1 } as unknown as R;
        rows(table).set(id, stored);
        return ok(structuredClone(stored));
      },
      updateWhereVersion: (table, id, expectedVersion, patch) =>
        apply(table, id, expectedVersion, patch),
      update: (table, id, patch) => apply(table, id, undefined, patch),
    };
  }

  return {
    ...readFrom(() => committed),
    now: () => clock.now(),
    transaction<T, E>(fn: (tx: Tx) => Promise<Result<T, E>>) {
      const run = tail.then(async () => {
        const work = cloneTables(committed);
        const outcome = await fn(makeTx(work)); // a throw leaves `committed` untouched (rollback)
        if (outcome.ok) committed = work;
        return outcome;
      });
      tail = run.catch(() => undefined);
      return run;
    },
  };
}
