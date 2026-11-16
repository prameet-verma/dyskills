import { lstat, readFile } from "node:fs/promises";
import { parse, type ParseError } from "jsonc-parser";
import { jsonContains } from "./json-merge";
import type { HostProbe, InstallPlan, JsonValue, VerifyReport } from "./types";

type Check = { name: string; ok: boolean; detail: string };

async function checkWrite(w: InstallPlan["writes"][number]): Promise<Check> {
  const name = `write:${w.path}`;
  try {
    if (w.kind === "dir") {
      return (await lstat(w.path)).isDirectory()
        ? { name, ok: true, detail: "directory exists" }
        : { name, ok: false, detail: "not a directory" };
    }
    const bytes = await readFile(w.path);
    if (w.kind === "file") {
      return bytes.equals(w.content)
        ? { name, ok: true, detail: "content matches" }
        : { name, ok: false, detail: "content differs from the plan" };
    }
    const text = bytes.toString("utf8");
    let actual: JsonValue | undefined;
    if (w.kind === "json-merge") {
      try {
        actual = JSON.parse(text) as JsonValue;
      } catch {
        return { name, ok: false, detail: "invalid JSON" };
      }
    } else {
      const errors: ParseError[] = [];
      actual = parse(text, errors, { allowTrailingComma: true }) as JsonValue | undefined;
      if (errors.length > 0) return { name, ok: false, detail: "invalid JSONC" };
    }
    return jsonContains(actual, w.patch)
      ? { name, ok: true, detail: "patch present" }
      : { name, ok: false, detail: "patch not fully present" };
  } catch (e) {
    return {
      name,
      ok: false,
      detail: `missing or unreadable: ${(e as NodeJS.ErrnoException).code ?? "error"}`,
    };
  }
}

/**
 * Checks an applied plan: each `file` exists with equal bytes, each merge target parses and
 * contains its patch, `dynamic-skills` is on `PATH`, and each verify command whose binary is on
 * `PATH` exits 0 with stdout matching `expect` (a missing binary is a passing, skipped check).
 */
export async function verifyInstall(plan: InstallPlan, probe: HostProbe): Promise<VerifyReport> {
  const checks: Check[] = [];
  for (const w of plan.writes) checks.push(await checkWrite(w));
  const self = await probe.which("dynamic-skills");
  checks.push({
    name: "dynamic-skills on PATH",
    ok: self !== null,
    detail: self ?? "dynamic-skills not found on PATH",
  });
  for (const cmd of plan.verify) {
    if ((await probe.which(cmd.bin)) === null) {
      checks.push({ name: cmd.name, ok: true, detail: `skipped: ${cmd.bin} not on PATH` });
      continue;
    }
    const r = await probe.run(cmd.bin, cmd.args);
    cmd.expect.lastIndex = 0;
    const ok = r.code === 0 && cmd.expect.test(r.stdout);
    checks.push({ name: cmd.name, ok, detail: ok ? "ok" : `exit ${r.code}; output did not match` });
  }
  return { ok: checks.every((c) => c.ok), checks };
}
