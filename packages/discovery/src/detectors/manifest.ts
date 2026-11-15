import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { EvidenceInput } from "@dynamic-skills/evidence-registry";
import { KNOWN_DATABASES, KNOWN_FRAMEWORKS, KNOWN_TEST_TOOLS } from "../known";
import type { Detector, DetectorContext } from "./types";

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parses JSON text, returning `null` for missing or malformed input instead of throwing. */
function parseJson(text: string | null): Json | null {
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

/** Parses TOML text, returning `null` for missing or malformed input instead of throwing. */
function parseTomlSafe(text: string | null): Json | null {
  if (text === null) return null;
  try {
    return parseToml(text) as Json;
  } catch {
    return null;
  }
}

const readJson = async (ctx: DetectorContext, rel: string) => parseJson(await ctx.readText(rel));

/** A declared dependency with the manifest it came from. */
interface Dep {
  range: string;
  source: string;
}

/** Splits a PEP 508 requirement ("fastapi[all]>=0.1") into a lowercase name and specifier. */
function parseRequirement(spec: string): { name: string; range: string } | null {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([^;#]*)/.exec(spec);
  if (!m?.[1]) return null;
  return { name: m[1].toLowerCase().replace(/_/g, "-"), range: (m[2] ?? "").trim() || "*" };
}

/**
 * Collects declared dependencies from `package.json`, `pyproject.toml` and `requirements.txt`.
 * Malformed manifests contribute nothing rather than failing discovery.
 */
async function collectDeps(ctx: DetectorContext): Promise<Map<string, Dep>> {
  const deps = new Map<string, Dep>();
  const put = (name: string, range: string, source: string) => {
    if (!deps.has(name)) deps.set(name, { range, source });
  };

  const pkg = await readJson(ctx, "package.json");
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const block = pkg?.[field];
    if (!isObject(block)) continue;
    for (const [name, range] of Object.entries(block)) {
      if (typeof range === "string") put(name, range, "package.json");
    }
  }

  const py = parseTomlSafe(await ctx.readText("pyproject.toml"));
  const fromList = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const r = typeof item === "string" ? parseRequirement(item) : null;
      if (r) put(r.name, r.range, "pyproject.toml");
    }
  };
  const project = py?.["project"];
  if (isObject(project)) {
    fromList(project["dependencies"]);
    const optional = project["optional-dependencies"];
    if (isObject(optional)) Object.values(optional).forEach(fromList);
  }
  const groups = py?.["dependency-groups"];
  if (isObject(groups)) Object.values(groups).forEach(fromList);
  const poetry = isObject(py?.["tool"]) ? (py["tool"] as Json)["poetry"] : undefined;
  if (isObject(poetry)) {
    const fromTable = (t: unknown) => {
      if (!isObject(t)) return;
      for (const [name, v] of Object.entries(t)) {
        if (name === "python") continue;
        const range =
          typeof v === "string"
            ? v
            : isObject(v) && typeof v["version"] === "string"
              ? v["version"]
              : "*";
        put(name.toLowerCase().replace(/_/g, "-"), range, "pyproject.toml");
      }
    };
    fromTable(poetry["dependencies"]);
    fromTable(poetry["dev-dependencies"]);
    const poetryGroups = poetry["group"];
    if (isObject(poetryGroups)) {
      for (const g of Object.values(poetryGroups)) if (isObject(g)) fromTable(g["dependencies"]);
    }
  }

  const req = await ctx.readText("requirements.txt");
  for (const line of req?.split(/\r?\n/) ?? []) {
    if (!line.trim() || line.trimStart().startsWith("#") || line.startsWith("-")) continue;
    const r = parseRequirement(line);
    if (r) put(r.name, r.range, "requirements.txt");
  }
  return deps;
}

/** Looks up an exact installed version in `package-lock.json` (lockfile v1 and v2/v3 shapes). */
async function lockedVersion(ctx: DetectorContext, name: string): Promise<string | null> {
  const lock = await readJson(ctx, "package-lock.json");
  if (!lock) return null;
  const packages = lock["packages"];
  const v3 = isObject(packages) ? packages[`node_modules/${name}`] : undefined;
  if (isObject(v3) && typeof v3["version"] === "string") return v3["version"];
  const legacy = isObject(lock["dependencies"]) ? lock["dependencies"][name] : undefined;
  if (isObject(legacy) && typeof legacy["version"] === "string") return legacy["version"];
  return null;
}

/**
 * Builds `<prefix>.<name>` evidence for each declared dependency in `known`.
 * A dependency is `inferred` from its manifest range; an exact `package-lock.json` version
 * upgrades it to `verified` because the lockfile records what is actually installed.
 */
async function depEvidence(
  ctx: DetectorContext,
  known: string[],
  prefix: string,
  category: EvidenceInput["category"],
): Promise<EvidenceInput[]> {
  const deps = await collectDeps(ctx);
  const out: EvidenceInput[] = [];
  for (const name of known) {
    const dep = deps.get(name);
    if (!dep) continue;
    const exact = dep.source === "package.json" ? await lockedVersion(ctx, name) : null;
    out.push({
      key: `${prefix}.${name}`,
      value: exact ?? dep.range,
      category,
      source: exact ? "package-lock.json" : dep.source,
      confidence: exact ? "verified" : "inferred",
      revision: ctx.revision,
    });
  }
  return out;
}

const cleanVersion = (text: string): string => text.trim().replace(/^v/i, "");

const runtimeDetector: Detector = {
  id: "runtime",
  categories: ["runtime"],
  always: true,
  async run(ctx) {
    const out: EvidenceInput[] = [];
    const base = { category: "runtime", revision: ctx.revision } as const;
    for (const file of [".nvmrc", ".node-version"]) {
      const text = await ctx.readText(file);
      const value = text === null ? "" : cleanVersion(text.split(/\r?\n/)[0] ?? "");
      if (value)
        out.push({ ...base, key: "runtime.node", value, source: file, confidence: "verified" });
    }
    const py = await ctx.readText(".python-version");
    const pyValue = py === null ? "" : (py.split(/\r?\n/)[0] ?? "").trim();
    if (pyValue) {
      out.push({
        ...base,
        key: "runtime.python",
        value: pyValue,
        source: ".python-version",
        confidence: "verified",
      });
    }
    const engines = (await readJson(ctx, "package.json"))?.["engines"];
    if (isObject(engines) && typeof engines["node"] === "string") {
      out.push({
        ...base,
        key: "runtime.node.engines",
        value: engines["node"],
        source: "package.json",
        confidence: "inferred",
      });
    }
    return out;
  },
};

/** One lockfile per package manager; each present lockfile is an independent observation. */
const LOCKFILES: [string, string][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["bun.lockb", "bun"],
  ["poetry.lock", "poetry"],
  ["uv.lock", "uv"],
];

const packageManagerDetector: Detector = {
  id: "package-manager",
  categories: ["package-manager"],
  always: true,
  async run(ctx) {
    const out: EvidenceInput[] = [];
    const base = {
      key: "package-manager",
      category: "package-manager",
      confidence: "verified",
      revision: ctx.revision,
    } as const;
    for (const [file, name] of LOCKFILES) {
      if (ctx.files.files.includes(file)) out.push({ ...base, value: name, source: file });
    }
    const field = (await readJson(ctx, "package.json"))?.["packageManager"];
    const name = typeof field === "string" ? /^([a-z]+)@/.exec(field)?.[1] : undefined;
    if (name) out.push({ ...base, value: name, source: "package.json#packageManager" });
    return out;
  },
};

const frameworkDetector: Detector = {
  id: "framework",
  categories: ["framework"],
  always: true,
  run: (ctx) => depEvidence(ctx, KNOWN_FRAMEWORKS, "framework", "framework"),
};

const databaseDetector: Detector = {
  id: "database",
  categories: ["database"],
  // Database facts are only worth discovering for data-related tasks (PRD §10.2 task-directed discovery).
  keywords: /migrat|database|schema|sql|orm|\bdb\b|persist/i,
  run: (ctx) => depEvidence(ctx, KNOWN_DATABASES, "database", "database"),
};

/** Config files that prove a test tool is configured, not merely installed. */
const TEST_CONFIGS: [RegExp, string][] = [
  [/^vitest\.config\.[cm]?[jt]s$/, "vitest"],
  [/^jest\.config\.[cm]?[jt]s$|^jest\.config\.json$/, "jest"],
  [/^\.mocharc\.(c?js|json|ya?ml)$/, "mocha"],
  [/^playwright\.config\.[cm]?[jt]s$/, "playwright"],
  [/^cypress\.config\.[cm]?[jt]s$/, "cypress"],
  [/^pytest\.ini$/, "pytest"],
];

const testingDetector: Detector = {
  id: "testing",
  categories: ["testing"],
  always: true,
  async run(ctx) {
    // Dependency-only evidence is inferred; config-file evidence is verified and wins on merge.
    const out = await depEvidence(ctx, KNOWN_TEST_TOOLS, "testing", "testing");
    // Reuse the declared range as the value so config + dependency observations merge instead
    // of registering as a spurious conflict; "configured" applies when there is no dependency.
    const deps = await collectDeps(ctx);
    const verified = (tool: string, source: string): EvidenceInput => ({
      key: `testing.${tool}`,
      value: deps.get(tool)?.range ?? "configured",
      category: "testing",
      source,
      confidence: "verified",
      revision: ctx.revision,
    });
    for (const file of ctx.files.files) {
      if (file.includes("/")) continue;
      for (const [re, tool] of TEST_CONFIGS) if (re.test(file)) out.push(verified(tool, file));
    }
    const py = parseTomlSafe(await ctx.readText("pyproject.toml"));
    const tool = py?.["tool"];
    if (isObject(tool) && isObject(tool["pytest"]) && isObject(tool["pytest"]["ini_options"])) {
      out.push(verified("pytest", "pyproject.toml"));
    }
    return out;
  },
};

const monorepoDetector: Detector = {
  id: "monorepo",
  categories: ["monorepo"],
  always: true,
  async run(ctx) {
    const out: EvidenceInput[] = [];
    const add = (name: string, value: string, source: string) =>
      out.push({
        key: `monorepo.${name}`,
        value,
        category: "monorepo",
        source,
        confidence: "verified",
        revision: ctx.revision,
      });
    if (ctx.files.files.includes("nx.json")) add("nx", "nx.json", "nx.json");
    if (ctx.files.files.includes("turbo.json")) add("turborepo", "turbo.json", "turbo.json");

    const pkg = await readJson(ctx, "package.json");
    const ws = pkg?.["workspaces"];
    const globs = Array.isArray(ws)
      ? ws
      : isObject(ws) && Array.isArray(ws["packages"])
        ? ws["packages"]
        : [];
    const strings = globs.filter((g): g is string => typeof g === "string");
    if (strings.length > 0) add("workspaces", strings.join(", "), "package.json");

    // Distinct key: package.json and pnpm-workspace.yaml are separate declarations and their
    // glob lists legitimately differ, so they must not be merged into a false conflict.
    const pnpm = await ctx.readText("pnpm-workspace.yaml");
    if (pnpm !== null) {
      let patterns: string[] = [];
      try {
        const doc: unknown = parseYaml(pnpm);
        const list = isObject(doc) ? doc["packages"] : undefined;
        if (Array.isArray(list)) patterns = list.filter((g): g is string => typeof g === "string");
      } catch {
        // Malformed YAML: still report that the file exists.
      }
      add("pnpm-workspace", patterns.join(", ") || "configured", "pnpm-workspace.yaml");
    }
    return out;
  },
};

const buildDetector: Detector = {
  id: "build",
  categories: ["build"],
  always: true,
  async run(ctx) {
    const out: EvidenceInput[] = [];
    const scripts = (await readJson(ctx, "package.json"))?.["scripts"];
    if (isObject(scripts)) {
      for (const [name, cmd] of Object.entries(scripts)) {
        if (typeof cmd !== "string") continue;
        out.push({
          key: `build.script.${name}`,
          value: cmd,
          category: "build",
          source: "package.json",
          confidence: "verified",
          revision: ctx.revision,
        });
      }
    }
    const make = await ctx.readText("Makefile");
    if (make !== null) {
      // Targets only: skip dot-targets (.PHONY) and variable assignments (`X := 1`).
      const targets = new Set(
        [...make.matchAll(/^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?![=:])/gm)].map(
          (m) => m[1] as string,
        ),
      );
      for (const t of targets) {
        out.push({
          key: `build.make.${t}`,
          value: `make ${t}`,
          category: "build",
          source: "Makefile",
          confidence: "verified",
          revision: ctx.revision,
        });
      }
    }
    return out;
  },
};

/** Detectors that read project manifests, lockfiles and config files (PRD §6.1 discovery). */
export const MANIFEST_DETECTORS: Detector[] = [
  runtimeDetector,
  packageManagerDetector,
  frameworkDetector,
  databaseDetector,
  testingDetector,
  monorepoDetector,
  buildDetector,
];
