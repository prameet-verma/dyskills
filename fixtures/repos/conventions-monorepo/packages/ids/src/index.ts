/** Prefixed, opaque ids: newId("ord") gives "ord_3f9c2a…". Never hand-roll ids. */
export function newId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function hasPrefix(prefix: string, id: string): boolean {
  return id.startsWith(`${prefix}_`);
}
