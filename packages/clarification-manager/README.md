# @dynamic-skills/clarification-manager

Bounded human clarification for a session: decides which questions are worth asking, pauses the
processing SLA while the user answers, and turns replies into evidence or recorded assumptions.
Implements PRD §10.3 (SLA pause/resume), §10.4 (question filtering and the three-round limit)
and §10.6 (assumptions for declined or unanswered questions).

## API

- **`ClarificationManager`** (`manager.ts`), constructed with a `SessionState` and an
  `EvidenceRegistry`. It mutates the state in place; the caller saves it.
  - `ask(questions, now)`: rejects, in order, `round-limit`, `not-material`,
    `answerable-by-evidence` (verified evidence key), `answerable-by-discovery` (its requirement
    has a gap still resolved by `inspect`) and `duplicate`. Accepting at least one question uses a
    round, sets them pending, sets status `waiting-for-clarification` and pauses the SLA.
  - `answer(answers, now)`: resumes the SLA and adds the wait to `metrics.humanWaitMs`. Answered
    questions become verified `user.<questionId>` evidence (origin `user`); declined, skipped and
    unanswered ones become assumptions and never evidence. Unresolved blocking questions go to
    `state.blockedBy`. Only pending questions can be answered (else throws `Question <id> is not
pending`); an `answered` reply needs a non-blank value; `answers: []` is valid.
  - `ask` throws if a round is still pending. Question ids must be unique across the whole
    session; a reused id is rejected as `duplicate`.
  - `canAskMore()`: whether a round remains.
- Types `AskResult`, `AnswerResult`, `RejectionReason`.

## Example

```ts
import { ClarificationManager } from "@dynamic-skills/clarification-manager";

const mgr = new ClarificationManager(state, registry);
const { accepted } = mgr.ask(questions, Date.now());
// ...later, once the user replies:
mgr.answer([{ questionId: "q1", status: "answered", value: "Redis" }], Date.now());
```
