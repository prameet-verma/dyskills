/** A domain error: a tagged-union member, never a class. */
export type DomainError<K extends string, D extends object = Record<never, never>> = {
  kind: K;
  message: string;
} & D;

/**
 * Build the factory for one error kind:
 *   const NotFound = defineError("NotFound");
 *   NotFound("order ord_1 not found", { id: "ord_1" })  // { kind, message, id }
 */
export function defineError<K extends string>(kind: K) {
  return <D extends object = Record<never, never>>(message: string, details?: D) =>
    ({ ...details, kind, message }) as DomainError<K, D>;
}
