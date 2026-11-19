/**
 * Returns the first `x.y.z[-prerelease]` version in `text`, or null. A prerelease tag
 * (`2.3.0-beta.1`) is kept so it never equals the plain release.
 */
export function parseVersion(text: string): string | null {
  const m = /\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?/.exec(text);
  return m ? m[0] : null;
}

/**
 * Compares two versions numerically on `x.y.z`: negative, zero or positive. A prerelease sorts
 * before its release (`1.0.0-beta < 1.0.0`); two prereleases compare identifier by identifier (numeric ones numerically, a numeric one before an
 * alphanumeric one, a shorter list first), per semver.
 */
export function compareVersions(a: string, b: string): number {
  const [ca = "", pa = ""] = splitPre(a);
  const [cb = "", pb = ""] = splitPre(b);
  const na = ca.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const nb = cb.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa === pb) return 0;
  if (pa === "") return 1;
  if (pb === "") return -1;
  const ia = pa.split(".");
  const ib = pb.split(".");
  for (let i = 0; i < Math.min(ia.length, ib.length); i++) {
    const x = ia[i] ?? "";
    const y = ib[i] ?? "";
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    if (nx) return -1;
    if (ny) return 1;
    return x < y ? -1 : 1;
  }
  return ia.length - ib.length;
}

function splitPre(v: string): [string, string] {
  const i = v.indexOf("-");
  return i < 0 ? [v, ""] : [v.slice(0, i), v.slice(i + 1)];
}
