# @dynamic-skills/activation

Gated, ephemeral activation of a generated skill, with a timeout fallback. It handles a new skill
and an augmentation (activated together with its unchanged base). A reused skill is returned by the
sufficiency step and never reaches this package.

Writes only inside the session directory. The base skill is only ever read, never modified.

## API

- `activate(input)`: async; resolves to an `ActivationResult`. Checks in order: deadline, pending
  clarifications, base integrity (when the verdict is `partial`, the base `SKILL.md` sha256 must
  equal the pinned one), the evaluation report, then the behavioural result. On success it returns
  the skill content, the base (augmentation only), `loadOrder` (base first) and limitations; status
  is `warning` when there are limitations, else `completed`; the outcome is `activated` or
  `augmented`. A refusal returns `reason` (`timeout`, `blocked-by-clarification`, `base-changed`,
  `evaluation-failed`, `behavioural-missing`) and the fallback "Continue the original task with
  existing capabilities."
- Every call sets `metrics.activationMs` and writes `reports/performance.json`,
  `reports/discovery.json`, `reports/assumptions.json` and (when a report exists)
  `reports/evaluation.json` as `{ ...report, behavioural }`. The caller persists the mutated state.
- A timeout deletes `<sessionDir>/skills/` and keeps `evidence.json`, `context-packet.json` and
  `context-analysis.json`.
- Types: `ActivationResult`, `ActivationInput`, `RefusalReason`.

## Example

```ts
import { activate } from "@dynamic-skills/activation";

const result = await activate({
  state,
  sessionDir,
  skill,
  report,
  behavioural,
  packet,
  evidence,
  now: Date.now(),
});
if (result.activated) console.log(result.loadOrder);
```

## PRD sections implemented

§5.5 (augmentation with unchanged base), §10.7 (timeout and fallback), §10.8 (reports), §11.1
(ephemeral activation), §11.3.
