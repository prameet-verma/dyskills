import { describe, expect, it } from "vitest";
import { deriveRequirements } from "../src/index";

const ids = (task: string): string[] => deriveRequirements(task).map((r) => r.id);
const BASELINE = ["language", "runtime", "package-manager", "testing", "build"];

describe("deriveRequirements", () => {
  it("returns exactly the baseline for a trivial task", () => {
    expect(ids("fix typo in README")).toEqual(BASELINE);
    expect(deriveRequirements("fix typo in README").every((r) => r.material && !r.humanOnly)).toBe(
      true,
    );
  });

  it("adds architecture for the PRD caching task", () => {
    expect(
      ids("Implement a new distributed caching strategy for the order-processing service"),
    ).toContain("architecture");
  });

  it("adds database, migration-policy and business-rules for a billing migration", () => {
    const reqs = deriveRequirements("write a database migration for billing");
    const found = (id: string) => reqs.find((r) => r.id === id);
    expect(found("database")).toBeDefined();
    expect(found("migration-policy")).toMatchObject({ humanOnly: true, category: "user" });
    expect(found("business-rules")).toMatchObject({ humanOnly: true, category: "user" });
  });

  it("adds ci, monorepo and conventions and never duplicates ids", () => {
    const list = ids("lint the workspace before the release pipeline, migrate schema, sql");
    expect(list).toEqual(expect.arrayContaining(["ci", "monorepo", "conventions", "database"]));
    expect(new Set(list).size).toBe(list.length);
  });
});

describe("deriveRequirements keyword boundaries", () => {
  it("does not treat 'orm' inside other words as a database task", () => {
    const list = ids("improve performance of the formatter on our platform");
    expect(list).not.toContain("database");
    expect(list).not.toContain("migration-policy");
  });

  it("matches ORM and SQL as whole words", () => {
    expect(ids("add an ORM model")).toContain("database");
    expect(ids("write SQL query")).toContain("database");
  });

  it("matches sql as a substring (mysql, postgresql, sqlite)", () => {
    for (const t of ["tune the mysql indexes", "postgresql connection pool", "sqlite fixture"])
      expect(ids(t)).toContain("database");
  });
});
