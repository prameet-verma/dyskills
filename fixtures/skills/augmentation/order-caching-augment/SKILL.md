---
name: order-caching-augment
description: Augments order-caching with this repository's order read and write paths, test command and task constraints for the distributed caching task.
metadata:
  augments: order-caching
  augments-sha256: "2e9a1408cd6661ef4175d835c0c957f56cb622bcc086a06fea8e18fd2eb6eec0"
---

# Order Caching — repository augmentation

## Task contract
- Objective: cache order reads in the order-processing service and invalidate them on every order write.
- Already covered by order-caching: cache key and TTL design, invalidation method, boundaries, accountability.
- Adds: this repository's read and write paths, its test command and the getOrder constraint.
- Success: tests cover hit, miss and invalidation on updateOrder.

## Project context
- TypeScript on Node.js 20.11.0, managed with pnpm [evidence: language.typescript] [evidence: runtime.node] [evidence: package-manager].
- Order reads go through `getOrder(id)` in `packages/orders/src/index.ts` [evidence: agentic.architecture.order-read-path].
- `updateOrder` appears to be the only write path that must invalidate cached reads [inferred: agentic.architecture.order-write-path].
- The test script is `pnpm test` [evidence: build.script.test] and tests appear to use Vitest [inferred: testing.vitest].

## Constraints
- Keep the public getOrder signature unchanged.
