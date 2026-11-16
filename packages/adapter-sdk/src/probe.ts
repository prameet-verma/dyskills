import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import type { HostProbe } from "./types";

async function isExecutableFile(p: string): Promise<boolean> {
  try {
    if (!(await stat(p)).isFile()) return false;
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a probe over `vars`. `which` scans `vars.PATH` for an executable regular file (no
 * shell). `run` uses `execFile` with `env: vars`, a 5 s timeout and a 64 KiB output cap, and never
 * throws: a spawn error, timeout or overflow is `code: -1`.
 */
export function createHostProbe(vars: Readonly<Record<string, string | undefined>>): HostProbe {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) env[k] = v;
  return {
    async which(bin) {
      if (bin === "" || bin.includes("\0")) return null;
      if (bin.includes("/")) return isAbsolute(bin) && (await isExecutableFile(bin)) ? bin : null;
      for (const dir of (vars.PATH ?? "").split(delimiter)) {
        if (dir === "" || !isAbsolute(dir)) continue;
        const candidate = join(dir, bin);
        if (await isExecutableFile(candidate)) return candidate;
      }
      return null;
    },
    run(bin, args) {
      return new Promise((resolve) => {
        try {
          execFile(
            bin,
            args,
            { env, timeout: 5_000, maxBuffer: 65_536, encoding: "utf8" },
            (err, stdout, stderr) => {
              const code = err === null ? 0 : typeof err.code === "number" ? err.code : -1;
              resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
            },
          );
        } catch (e) {
          resolve({ code: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) });
        }
      });
    },
  };
}
