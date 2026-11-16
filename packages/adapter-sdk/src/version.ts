/** Returns the first `x.y.z` version in `text`, or null. */
export function parseVersion(text: string): string | null {
  const m = /\d+\.\d+\.\d+/.exec(text);
  return m ? m[0] : null;
}

/** Compares two `x.y.z` versions numerically: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
