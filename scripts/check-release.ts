import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Every file the published tarball may contain. */
const ALLOWED =
  /^(dist\/.+|skills\/dynamic-skill-bootstrap\/SKILL\.md|package\.json|README\.md|LICENSE)$/;

/** Files the tarball must contain. */
const REQUIRED = [
  "dist/index.js",
  "skills/dynamic-skill-bootstrap/SKILL.md",
  "package.json",
  "README.md",
];

/**
 * Checks that a packed CLI is releasable.
 * @param input The release tag (omit it for a dry run: the tag check is skipped), the packed `package.json` and the tarball's file list.
 * @returns Human-readable problems; an empty array means the package is releasable.
 */
export function checkRelease(input: {
  tag?: string;
  pkg: Record<string, unknown>;
  packFiles: string[];
}): string[] {
  const { tag, pkg, packFiles } = input;
  const problems: string[] = [];
  if (tag !== undefined && tag !== `v${String(pkg.version)}`) {
    problems.push(
      `tag ${tag} does not match package version ${String(pkg.version)} (expected v${String(pkg.version)})`,
    );
  }
  if (pkg.name !== "dynamic-skills")
    problems.push(`package name must be "dynamic-skills", got ${String(pkg.name)}`);
  if (pkg.private === true) problems.push("package is private");
  const bin = pkg.bin as Record<string, unknown> | undefined;
  if (bin?.["dynamic-skills"] !== "dist/index.js") {
    problems.push('bin["dynamic-skills"] must be "dist/index.js"');
  }
  const deps = (pkg.dependencies ?? {}) as Record<string, unknown>;
  for (const [name, range] of Object.entries(deps)) {
    if (typeof range === "string" && range.startsWith("workspace:")) {
      problems.push(`dependency ${name} uses a workspace: range`);
    }
    if (name.startsWith("@dynamic-skills/"))
      problems.push(`dependency ${name} is a workspace package and will not resolve from npm`);
  }
  if (typeof pkg.license !== "string" || pkg.license === "") {
    problems.push("package.json has no license field (choose a license and add LICENSE)");
  }
  if (typeof pkg.license === "string" && pkg.license !== "" && !packFiles.includes("LICENSE")) {
    problems.push("tarball is missing LICENSE (add it at the repository root and to packages/cli)");
  }
  if (pkg.repository === undefined || pkg.repository === "") {
    problems.push("package.json has no repository field");
  }
  for (const required of REQUIRED) {
    if (!packFiles.includes(required)) problems.push(`tarball is missing ${required}`);
  }
  for (const file of packFiles) {
    if (!ALLOWED.test(file)) problems.push(`tarball contains unexpected file ${file}`);
  }
  return problems;
}

/** Packs the CLI into a temp dir and returns its packed `package.json` and file list. */
function pack(): { pkg: Record<string, unknown>; packFiles: string[] } {
  const cwd = resolve(import.meta.dirname, "../packages/cli");
  const dest = mkdtempSync(join(tmpdir(), "ds-release-"));
  try {
    execFileSync("pnpm", ["pack", "--pack-destination", dest], { cwd, stdio: "pipe" });
    const tgz = join(dest, readdirSync(dest).find((f) => f.endsWith(".tgz")) as string);
    const packFiles = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l !== "" && !l.endsWith("/"))
      .map((l) => l.replace(/^package\//, ""));
    const json = execFileSync("tar", ["-xzOf", tgz, "package/package.json"], { encoding: "utf8" });
    return { pkg: JSON.parse(json) as Record<string, unknown>, packFiles };
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf("--tag");
  const tag = i >= 0 ? process.argv[i + 1] : undefined;
  if (i >= 0 && tag === undefined) {
    console.error("usage: tsx scripts/check-release.ts [--tag <tag>]");
    process.exit(2);
  }
  const { pkg, packFiles } = pack();
  const problems = checkRelease({ tag, pkg, packFiles });
  for (const p of problems) console.error(`release check: ${p}`);
  if (problems.length > 0) process.exit(1);
  console.log("release check passed");
}
