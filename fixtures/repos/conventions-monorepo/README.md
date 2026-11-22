# conventions-monorepo

A small TypeScript monorepo for an imaginary company ("acme"): an order service, an inventory
service and the shared libraries they are built on. It is a pnpm workspace; each directory under
`packages/` is a package.

- `packages/orders`: order lifecycle (create, read, update).
- `packages/inventory`: stock reservation, a complete feature.
- `packages/*` (the rest): shared libraries used by both services.

Install with `pnpm install`, run the specs with `pnpm test` and the type check with
`pnpm typecheck`. Team conventions and design decisions are written down in `docs/`.
