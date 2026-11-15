import type { ContextPacket, Evidence } from "@dynamic-skills/core";
import type { RepoFileIndex } from "@dynamic-skills/discovery";

/** Evidence that is established enough to describe the technology (not assumed or conflicting). */
const reliable = (e: Evidence): boolean =>
  e.confidence === "verified" || e.confidence === "inferred";

/** Suffix of a dotted evidence key after `prefix.`, or undefined when the prefix differs. */
const suffix = (key: string, prefix: string): string | undefined =>
  key.startsWith(`${prefix}.`) ? key.slice(prefix.length + 1) : undefined;

/**
 * Projects evidence onto the packet's `technology` block (PRD §6.4). Conflicting or assumed
 * facts are left out so the agent is not handed a guess as a fact.
 *
 * @param evidence - Registry contents.
 * @returns Languages, frameworks, runtimes (`"<name> <version>"`) and package managers.
 */
export function projectTechnology(evidence: Evidence[]): ContextPacket["technology"] {
  const ok = evidence.filter(reliable);
  const names = (prefix: string): string[] =>
    ok.flatMap((e) => {
      const s = suffix(e.key, prefix);
      return s === undefined ? [] : [s];
    });
  return {
    languages: names("language"),
    frameworks: names("framework"),
    // Only `runtime.<name>`; deeper keys such as `runtime.node.engines` are constraints.
    runtimes: ok.flatMap((e) => {
      const s = suffix(e.key, "runtime");
      return s !== undefined && !s.includes(".") ? [`${s} ${e.value}`] : [];
    }),
    packageManagers: ok.filter((e) => e.key === "package-manager").map((e) => e.value),
  };
}

/**
 * Lists dependency-like evidence (frameworks, databases, test tools) with its evidence key.
 *
 * @param evidence - Registry contents.
 * @returns One entry per `framework.*`, `database.*` and `testing.*` item, in evidence order.
 */
export function projectDependencies(evidence: Evidence[]): ContextPacket["dependencies"] {
  return evidence.flatMap((e) => {
    for (const prefix of ["framework", "database", "testing"]) {
      const name = suffix(e.key, prefix);
      if (name !== undefined) return [{ name, version: e.value, evidenceKey: e.key }];
    }
    return [];
  });
}

/**
 * Reads a comma-separated list stored in an evidence value.
 *
 * @param evidence - Registry contents.
 * @param key - Evidence key such as `architecture.top-level-dirs`.
 * @returns Trimmed non-empty items, or an empty array when the key is absent.
 */
export function projectList(evidence: Evidence[], key: string): string[] {
  const value = evidence.find((e) => e.key === key)?.value;
  return value
    ? value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

const MAX_CONFIG_FILES = 20;

/** Classification of well-known configuration files by basename (PRD §6.4). */
const CONFIG_KINDS: [ContextPacket["configuration"][number]["kind"], RegExp][] = [
  [
    "build",
    /^(tsconfig.*\.json|(vite|webpack|rollup|tsup)\.config\.[cm]?[jt]s|babel\.config\.[cm]?js|Makefile)$/,
  ],
  ["test", /^((vitest|jest|playwright|cypress)\.config\.[cm]?[jt]s|pytest\.ini|conftest\.py)$/],
  ["monorepo", /^(nx\.json|turbo\.json|pnpm-workspace\.yaml|lerna\.json)$/],
  ["runtime", /^(\.nvmrc|\.node-version|\.python-version|\.tool-versions)$/],
];

/**
 * Classifies indexed files as configuration, shallowest first, capped at 20.
 *
 * @param files - File index (paths only; nothing is read).
 * @returns `{ path, kind }` entries.
 */
export function projectConfiguration(files: RepoFileIndex): ContextPacket["configuration"] {
  const depth = (p: string): number => p.split("/").length;
  const out: ContextPacket["configuration"] = [];
  const sorted = [...files.files].sort(
    (a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const path of sorted) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    let kind: ContextPacket["configuration"][number]["kind"] | undefined;
    if (path.startsWith(".github/workflows/") || path === ".gitlab-ci.yml") kind = "ci";
    else kind = CONFIG_KINDS.find(([, re]) => re.test(base))?.[0];
    // `other`: only the root manifests, not every nested package.json.
    if (!kind && (path === "package.json" || path === "pyproject.toml")) kind = "other";
    if (kind) out.push({ path, kind });
    if (out.length >= MAX_CONFIG_FILES) break;
  }
  return out;
}
