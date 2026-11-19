import { spawn } from "node:child_process";
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
 * shell). `run` uses `spawn` (detached) with `env: vars`, a hard timeout (default 5 s: SIGKILL of the whole process group, then resolve; a normal exit resolves as soon as the child has exited, whatever still holds its pipes; `timeoutMs` overrides it) and a 64 KiB output cap (overflow kills the group), and never
 * throws: a spawn error, timeout or overflow is `code: -1`.
 *
 * The child is detached (its own process group), so Ctrl-C in the terminal does not reach a hung
 * probe, and an orphan can outlive the CLI if the CLI is killed before the timeout fires.
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
        const timers: NodeJS.Timeout[] = [];
        let out = "";
        let err = "";
        let bytes = 0;
        let overflow = false;
        const finish = (r: { code: number; stdout: string; stderr: string }): void => {
          if (done) return;
          done = true;
          for (const t of timers) clearTimeout(t);
          resolve(r);
        };
        let child: ReturnType<typeof spawn>;
        try {
          // detached: the child leads its own process group, so a timeout can kill grandchildren.
          child = spawn(bin, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
        } catch (e) {
          finish({ code: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) });
          return;
        }
        const killGroup = (): void => {
          try {
            if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        };
        let exited = false;
        const collect = (which: "out" | "err") => (chunk: string) => {
          const room = 65_536 - bytes;
          const size = Buffer.byteLength(chunk);
          if (size > room) {
            // The cap counts only while the child is alive; afterwards output is just truncated.
            if (!exited) {
              overflow = true;
              killGroup();
            }
            return;
          }
          bytes += size;
          if (which === "out") out += chunk;
          else err += chunk;
        };
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", collect("out"));
        child.stderr?.on("data", collect("err"));
        child.stdout?.on("error", () => undefined);
        child.stderr?.on("error", () => undefined);
        child.on("error", (e) => finish({ code: -1, stdout: "", stderr: e.message }));
        // Resolve on `exit`, not only `close`: a background child may hold the pipes open for ever.
        // After `exit` the already-buffered output gets a short grace to drain, then the streams are
        // destroyed.
        const settle = (code: number | null): void => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(
            overflow || code === null
              ? { code: -1, stdout: out, stderr: err }
              : { code, stdout: out, stderr: err },
          );
        };
        child.on("close", (code) => settle(code));
        child.on("exit", (code) => {
          exited = true;
          const grace = setTimeout(() => settle(code), 100);
          grace.unref();
          timers.push(grace);
        });
        const backstop = setTimeout(() => {
          killGroup();
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish({ code: -1, stdout: out, stderr: "timed out" });
        }, timeoutMs);
        backstop.unref();
        timers.push(backstop);
      });
    },
  };
}
