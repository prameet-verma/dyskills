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
 * shell). `run` uses `execFile` with `env: vars`, a hard timeout (default 5 s: SIGKILL, then resolve without waiting for the streams; `timeoutMs` overrides it) and a 64 KiB output cap, and never
 * throws: a spawn error, timeout or overflow is `code: -1`.
 */
export function createHostProbe(
  vars: Readonly<Record<string, string | undefined>>,
  timeoutMs = 5_000,
): HostProbe {
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
        let done = false;
        let timer: NodeJS.Timeout | undefined;
        const finish = (r: { code: number; stdout: string; stderr: string }): void => {
          if (done) return;
          done = true;
          if (timer !== undefined) clearTimeout(timer);
          resolve(r);
        };
        try {
          const child = execFile(
            bin,
            args,
            { env, maxBuffer: 65_536, encoding: "utf8" },
            (err, stdout, stderr) => {
              const code = err === null ? 0 : typeof err.code === "number" ? err.code : -1;
              finish({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
            },
          );
          // A hard bound: SIGKILL (a binary may trap SIGTERM) and resolve without waiting for the
          // stdio streams to close.
          timer = setTimeout(() => {
            child.kill("SIGKILL");
            child.stdout?.destroy();
            child.stderr?.destroy();
            finish({ code: -1, stdout: "", stderr: "timed out" });
          }, timeoutMs);
          timer.unref();
        } catch (e) {
          finish({ code: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) });
        }
      });
    },
  };
}
