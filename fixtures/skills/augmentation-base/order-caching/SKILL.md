---
name: order-caching
description: Designs caching for order services, including cache keys, TTLs and invalidation on writes.
---

# Order Caching

## Ownership
- Cache design for order reads: keys, TTLs and invalidation.

## Decision rights
- Choose cache keys, TTLs and invalidation triggers.

## Boundaries
- Do not change public APIs or persisted data formats.

## Methodology
1. List read paths and the write paths that must invalidate them.
2. Put the cache behind the data-access boundary.
3. Write failing tests for hit, miss and invalidation first.

## Accountability
- Report which write paths clear which keys.
