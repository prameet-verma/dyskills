/** Active processing budget (wall-clock minus human-wait pauses). */
export const DEFAULT_BUDGET_MS = 60_000;
export const MAX_CLARIFICATION_ROUNDS = 3;
/** Initial attempt plus two revisions. */
export const MAX_EVAL_ATTEMPTS = 3;
export const SKILL_TOKEN_SOFT_LIMIT = 2000;
export const SKILL_TOKEN_HARD_LIMIT = 5000;
export const DISCOVERY_CONCURRENCY = 4;
export const EVAL_CONCURRENCY = 6;
