import type { Requirement } from "@dynamic-skills/core";

/** Builds a requirement; every requirement is material unless a rule says otherwise. */
const req = (
  id: string,
  category: Requirement["category"],
  description: string,
  humanOnly = false,
): Requirement => ({ id, category, description, humanOnly, material: true });

/** Context every task needs, regardless of wording (PRD §6.3). */
const BASELINE: Requirement[] = [
  req("language", "language", "Primary programming languages of the repository."),
  req("runtime", "runtime", "Runtime and version the code targets."),
  req("package-manager", "package-manager", "Package manager used to install and run scripts."),
  req("testing", "testing", "Test framework and how tests are run."),
  req("build", "build", "How the project is built and which scripts or targets exist."),
];

/**
 * Keyword rules, matched case-insensitively against the task text. A rule may add several
 * requirements; `humanOnly` ones can only be answered by the user (PRD §6.3).
 */
const RULES: { pattern: RegExp; add: Requirement[] }[] = [
  {
    pattern: /migrat|database|schema|sql|orm/i,
    add: [
      req("database", "database", "Database engine and data-access layer in use."),
      req("migration-policy", "user", "Migration rollout and backward-compatibility policy", true),
    ],
  },
  {
    pattern: /deploy|release|\bci\b|pipeline/i,
    add: [req("ci", "ci", "CI/CD pipeline that builds, tests and releases the project.")],
  },
  {
    pattern: /monorepo|module boundar|workspace/i,
    add: [req("monorepo", "monorepo", "Monorepo tooling and package boundaries.")],
  },
  {
    pattern: /architect|refactor|service|design|cach/i,
    add: [
      req(
        "architecture",
        "architecture",
        "Module boundaries, entrypoints and layering of the code.",
      ),
    ],
  },
  {
    pattern: /business|domain rule|policy|pricing|payment|billing/i,
    add: [req("business-rules", "user", "Business rules the change must respect.", true)],
  },
  {
    pattern: /convention|style|review|lint/i,
    add: [req("conventions", "conventions", "Coding conventions and contribution guidelines.")],
  },
];

/**
 * Derives the context a task needs before a skill can be generated.
 *
 * @param task - Free-text task description.
 * @returns The baseline requirements followed by keyword-triggered ones, in rule order, with
 *   unique ids (a requirement added by two rules appears once).
 */
export function deriveRequirements(task: string): Requirement[] {
  const out = [...BASELINE];
  for (const rule of RULES) {
    if (!rule.pattern.test(task)) continue;
    for (const r of rule.add) if (!out.some((o) => o.id === r.id)) out.push(r);
  }
  return out;
}
