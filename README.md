# `@friendmatch/algorithm`

Activity recommendation and matching for a "find someone to do this with" app.

TypeScript, ESM, Node 22. **Zero runtime dependencies.** Everything external —
your database, your LLM, your cache, your profile store — is a port you inject.

---

## The design rule

> **Use LLMs to understand ambiguous human intent. Use deterministic code and
> database operations to determine matches.**

The LLM is a *semantic parser and nothing else*. It turns the string
`"wanna sweat a bit before dinner"` into `{ canonicalActivity: 'treadmill',
category: 'fitness', tags: [...], confidence: 0.86 }` — and its output is
validated back onto the controlled vocabulary before anything downstream sees
it (`src/semantic/schema.ts`).

The LLM never:

- decides which event wins,
- computes a distance or a time difference,
- checks capacity or expiry,
- authorizes anything,
- joins a user to an event, or creates one.

All of that is pure functions plus one transactional repository call.

### Why: the two paths

| | `recommend(intent, userId?)` | `match(userId, intent)` |
|---|---|---|
| **Role** | real-time, **advisory** | **authoritative** |
| **Writes?** | never (read-only) | joins or creates |
| **LLM?** | **impossible** — see below | at most one call, only for genuinely new ambiguous text |
| **Freshness** | may be stale; `advisory: true` says so | revalidates every join transactionally |
| **Latency budget** | as you type / as you tap | one round trip on submit |

`recommend` exists so the UI can show "3 people are doing this near you" while
the user is still deciding. It is explicitly allowed to be wrong. `match` is
the one that counts, and it never trusts anything `recommend` produced — a
cached recommendation is not proof an event can be joined. The join is a
conditional write, and only its success produces a `MATCHED` outcome.

**How "zero LLM calls in `recommend`" is enforced.** Not by discipline — by
the type system:

1. `src/services/recommendation.ts` imports no LLM symbol at all. There is no
   `LlmClient` and no `SemanticParser` in scope, so no call site can exist.
2. `RecommendationServiceDeps` declares `llm?: never` and `parser?: never`.
   Handing the real-time path an LLM is a compile error.

`src/services/suggestions.ts` carries the same two guards.

---

## LLM calls per request

| Input | Path | LLM calls |
|---|---|---|
| Button-only, e.g. `{ activityIds: ['treadmill'] }` | structured normalization against the vocabulary | **0** |
| Known synonym text, e.g. `"hit the gym at 4pm"` | deterministic: exact id → synonym → longest token | **0** |
| Free text seen before | semantic cache (default TTL **7 days**) | **0** |
| New, genuinely ambiguous text | one `extractSemantics` call, result cached | **1** |
| Any `recommend(...)` call, whatever the text | deterministic layer only; unresolvable text returns `{ recommendations: [], advisory: true, cacheHit: false }` without touching the repository | **0** |
| Any `suggestActivities(...)` call | deterministic ranking over the vocabulary | **0** |

`llmCallRatio(metrics.snapshot())` gives you `llm.calls / match.requests` in
production. On a button-driven UI it should sit near zero.

---

## Ports

Everything is injected through `createMatchingEngine(deps)`. Nothing is a
singleton import.

| Port | You must implement it? | What ships here |
|---|---|---|
| `EventRepository` | **Yes. Always.** | `createInMemoryEventRepository()` — *reference/dev implementation only*, see below |
| `UserProfileService` | Realistically yes | none. Absent ⇒ no profile personalization, no home-location fallback |
| `AvailabilityService` | Realistically yes | none. Absent ⇒ time falls back to `now + fallbackStartOffsetMinutes` |
| `CacheService` | No | `createMemoryCache()` (in-process, **not** shared across instances), `createNullCache()` |
| `LocationService` | No | `createLocationService(CMU_LOCATIONS)` — 17 CMU-area locations (15 campus buildings plus Schenley Park and Craig Street, which carry their own `campusId`), haversine distance |
| `LlmClient` | No | `createAnthropicLlmClient()` (dependency-free `fetch`, forced tool call, injectable `fetchImpl`), `createNullLlmClient()` |
| `IdempotencyStore` | No, but you want one | `createInMemoryIdempotencyStore()` — *dev only*, single-process |
| `Clock` | No | `systemClock()`, `fixedClock()` for tests |
| `Metrics` | No | `createInMemoryMetrics()` (with `snapshot()`), `createNoopMetrics()` |

The in-memory adapters exist to pin the *semantics* the real ones must match
(especially concurrency) and to make the test suite hermetic. Do not ship them.

```ts
import { createMatchingEngine } from '@friendmatch/algorithm';

const engine = createMatchingEngine({
  events: myPostgresEventRepository,   // required
  profiles: myProfileService,
  availability: myCalendarService,
  cache: myRedisCache,
  llm: createAnthropicLlmClient({ taxonomy: engineTaxonomy }),
  idempotency: myRedisIdempotencyStore,
  config: { matchThreshold: 0.72 },    // deep-partial override
});
```

---

## The production `EventRepository` contract

Three methods, and one of them is where correctness actually lives.

### `joinEventAtomically` — the atomic conditional update

The revalidate-and-join **must be a single conditional statement**, never a
read followed by a write. With capacity 4 and 3 participants, two concurrent
callers must produce exactly one `ok: true`. Verbatim from the contract in
`src/adapters/inMemoryEventRepository.ts`:

```sql
-- One statement: the WHERE clause IS the revalidation. If zero rows come
-- back, the caller failed one of NOT_OPEN / EXPIRED / FULL and must
-- re-derive which by re-reading the row (outside the write path).
UPDATE events
   SET participant_count = participant_count + 1,
       status = CASE WHEN participant_count + 1 >= capacity
                     THEN 'MATCHED' ELSE status END
 WHERE id = $1
   AND status = 'OPEN'
   AND expires_at > now()
   AND participant_count < capacity
 RETURNING *;

-- Same transaction:
INSERT INTO participants (event_id, user_id) VALUES ($1, $2);
```

Plus a `UNIQUE (event_id, user_id)` constraint on the participants table as a
second line of defence against double-joins (e.g. a retried request).

**Read-count-then-insert is forbidden.** `SELECT participant_count ...`
followed by a separate `INSERT`/`UPDATE` loses races under concurrent joins —
two callers can both read `count < capacity` and both write. Only the
conditional `UPDATE ... WHERE ... RETURNING` above (or an equivalent
`SELECT ... FOR UPDATE` transaction) is safe.

`createEvent` must insert the event row and the creator's participant row in
that same transaction, so the event is never visible as `OPEN` with zero
recorded participants.

### Required indexes

`findCandidates` is stage-1 retrieval: bounded, indexed, and it must push
status / expiry / capacity filtering into the query rather than returning rows
for the application to discard.

```
(status, expires_at, activity_id)
(status, expires_at, category_id)
(status, expires_at, location_id, start_time)
```

These match `CandidateQuery`'s predicates: status/expiry are always filtered,
activity/category is an OR'd equality probe, and location/start_time supports
the location scan plus window intersection. `CandidateQuery.limit` is always
set — the engine never compares an intent against every event in the store.

---

## Configuration

`resolveConfig(overrides)` merges one nested level onto `DEFAULT_CONFIG`
(`src/config/defaults.ts`). Everything is a tuning knob; nothing is a law.

| Knob | Default | What it does / when to move it |
|---|---|---|
| `weights` | activity .40, time .25, location .20, tag .10, quality .05 | Relative pull of the five sub-scores. **Must sum to 1** — `assertWeightsSumToOne` runs once at engine construction and throws otherwise. Raise `time` on a commuter campus; raise `location` on a sprawling one. |
| `matchThreshold` | `0.70` | Score a candidate must reach before the user is joined to it. Lower ⇒ more joins, more mediocre pairings. Raise it if users report bad matches; watch `match.matched` vs `match.pending`. |
| `activitySimilarity` | exact 1.0, parent .8, child .7, related .7, sibling .6, sameCategory .35, unrelated 0 | How far the taxonomy will stretch. Widening `sibling`/`sameCategory` makes near-misses matchable. |
| `location.bands` / `sameCampus` / `far` | 0m→1.0, 250m→0.9, 800m→0.7; campus .5; far 0 | Distance→score. Tune to how far your users will actually walk. |
| `time.perfectToleranceMinutes` / `maxToleranceMinutes` | 5 / 90 | Start-time slack. Beyond `max`, compatibility is 0. |
| `cache.semanticMs` | 7 days | Semantics of a phrase change slowly. This is the knob that keeps the LLM bill near zero. |
| `cache.recommendationMs` | 15 s | Advisory staleness. Higher = fewer queries, staler counts. |
| `cache.recommendationTimeBucketMs` | 5 min | Time-bucket width in the cache key — keeps exact timestamps out of keys so nearby requests share an entry. |
| `cache.suggestionsMs` | 5 min | Also the bucket width for the suggestions key. |
| `candidateLimit` / `recommendationLimit` | 100 / 10 | Stage-1 retrieval bound; events returned to the UI. |
| `retrievalWindowMinutes` | 180 | How far either side of the requested start we scan for overlap. |
| `defaultEventTtlMinutes` | 120 | Matching window for events this engine creates (see expiry rule below). |
| `defaultEventCapacity` | 6 | Capacity of created events. |
| `fallbackStartOffsetMinutes` | 15 | "Sometime soon" when there is no explicit time, no relative phrase, and no availability data. |
| `minSemanticConfidence` | 0.40 | Below this the LLM interpretation is discarded and the request degrades to structured input. |
| `maxSuggestionsPerCategory` / `suggestionLimit` | 2 / 6 | The diversity constraint (below). |

---

## Behaviour worth knowing before you integrate

### Merge rule: structured selections win

When a request carries both button selections and free text, **structured
activity selections beat the semantic interpretation on conflict; tags are
unioned.** A tap is an unambiguous statement; a parse is an inference. Tap
"basketball" and type "or maybe a run" and you get basketball — but the prose's
tags still merge in, so events with that flavour rank higher. `categoryIds`
always comes from the taxonomy, never from the model.

*Cost note:* free text is parsed whenever it is present, **including when a
button was also pressed**. If that text is novel and ambiguous, the request
still spends its one LLM call — the structured selection decides the activity,
and the parse contributes only tags. The call is triggered by the text, not by
the absence of a selection. A button-only request (no `text` at all) is the
zero-call case.

### Created-event expiry

`expiresAt = min(createdAt + defaultEventTtlMinutes, endTime)`. The TTL bounds
how long we keep matching into the event; the end time bounds when the activity
is actually over. Matching must never outlive the activity, so the earlier wins.

*Edge case, deliberate:* if you pass an explicit time window that has already
ended, the created event is born expired and is invisible to retrieval. That is
consistent with the rest of the engine (a past window can't match anything
either). **Rejecting past time windows is input validation and belongs to your
API layer.**

### Events with no location

If a user names no location, has no device coordinates, and has no home
location on their profile, the created event gets `locationId:
'unspecified'` (exported as `UNSPECIFIED_LOCATION_ID`). It is not a real place:
`LocationService.getLocation` returns `undefined` for it, so it scores
`config.location.far` for anyone who *did* name a location, and is unaffected
for anyone who didn't. Silently pinning the event to some arbitrary building
would assert a fact nobody supplied.

### Intents with no resolvable activity are REJECTED

If nothing in a `match` request resolves to the controlled vocabulary — no
valid structured id, no deterministic text match, no usable semantic
interpretation — `match` returns

```ts
{ status: 'REJECTED', reason: 'NO_RESOLVABLE_ACTIVITY', semanticSource }
```

**Map it to HTTP 422.** `match` does not throw for this: a user typing
something unmappable is an ordinary condition, so it is reported as an outcome
and callers get exhaustive type-checking instead of a `try/catch`.

Rejecting is the deliberate choice over the alternative. `EventDraft` requires
a real activity id, so "create something anyway" would mean writing an event
under a synthetic activity — a row `buildCandidateQuery` could never retrieve,
because it expands through the taxonomy and drops unknown ids. That is a
permanently unmatchable orphan. Refusing beats corrupting.

A `REJECTED` outcome is **never written to the idempotency store**: nothing
durable was created, so a retry should be free to resolve differently once the
caller supplies an activity selection.

### Category-only intents can never match — and cannot occur

`activityScore` scores a category-only intent at
`activitySimilarity.sameCategory` (0.35), which caps the achievable total at
0.74 against a 0.70 threshold — reachable only with *simultaneously perfect*
time, location, tag and quality sub-scores, which in practice never happens
(`tagScore` is never 1.0 for a tagless intent). So a category-only intent would
always create rather than join.

**This is accepted, not fixed, because it is unreachable through the public
API.** `RawIntent` has no `categoryIds` field: `NormalizedIntent.categoryIds` is
always *derived* from validated activity ids, so an intent with categories but
no activities cannot be constructed by a client. The branch only fires if you
hand-build a `NormalizedIntent` and call `scoreEvent`/`rankCandidates`
directly. If you do that and want it to match, add a dedicated
`categoryOnly` similarity value rather than raising `sameCategory` (which would
also loosen real activity-to-activity matching).

### Recommendation cache is user-scoped

`recommendationKey` keys on the normalized intent only, but results are
user-specific: `excludeUserId` and the hard filters remove the caller's own and
already-joined events. Serving user A's cached list to user B would show B
their own events back, so the service suffixes the pinned key with the caller's
scope. Anonymous callers share one entry, correctly.

### Suggestion diversity

`suggestActivities` scores the whole vocabulary from profile interests (graded
through the taxonomy, so listing `running` also surfaces `treadmill`), recent
activity (geometric position decay), a documented time-of-day table
(`TIME_OF_DAY_FIT`, exported and swappable), location context, and campus
popularity. It then admits at most `maxSuggestionsPerCategory` per category, so
the UI never shows Workout / Running / Treadmill / Gym / Cardio as five
separate suggestions.

Popularity defaults to one bounded open-event sweep per cache miss. **In
production, inject `popularity`** (`ActivityPopularitySource`) backed by a
materialized view or counter table — "open events per activity" is a
once-a-minute aggregate, not a per-user query.

### Graceful degradation

LLM down, availability down, cache down, profile service down, location
unknown — every one of these degrades to a usable outcome built from the
structured information. None of them fails a request. Repository errors during
the join loop are recorded as conflicts and the next candidate is tried; a
genuine total outage still surfaces, via `createEvent`.

### Privacy

No raw user text and no profile field is ever logged. The `Metrics` port is
numeric-only by construction — `increment`/`observe` take a `MetricName` from a
fixed union and a `number`, with no way to attach a text label.

Free text reaches exactly two places, and no others. It is **sent** to the LLM,
and only when the deterministic and cached tiers both miss. It is also
**embedded in the semantic cache key**, as `semantic:{normalizedText}` — the
key format the spec pins, and the only way a repeat of the same phrase can be
recognized without a call. `semanticKey` lowercases, strips punctuation and
collapses whitespace, and hashes the segment once it exceeds 64 characters, but
a short phrase appears in the key verbatim. That is not a concern for the
in-process default cache; **if you swap in Redis, the phrases your users type
become keys in that shared keyspace.** Give the engine its own Redis database
or key prefix, apply your retention policy to it, and treat
`cache.semanticMs` (7 days) as a data-retention knob and not only a
performance one.

---

## Metrics

`llm.calls` · `llm.errors` · `llm.latency_ms` · `semantic.cache.hit|miss` ·
`semantic.deterministic.hit` · `recommendation.latency_ms` ·
`recommendation.cache.hit|miss` · `recommendation.candidates` ·
`match.requests` · `match.candidates` · `match.score` · `match.matched` ·
`match.pending` · `match.rejected` · `match.join_conflict` ·
`match.latency_ms` · `event.created` · `suggestions.cache.hit|miss`

Helpers: `llmCallRatio`, `semanticCacheHitRate`, `recommendationCacheHitRate`.

Worth alerting on: `llmCallRatio` climbing (your synonym table has gaps),
`match.join_conflict` climbing (real contention, or a repository that isn't
atomic), `recommendation.candidates` pinned at `candidateLimit` (queries too
broad).

---

## What this deliberately does NOT do

- **No database schema.** No migrations, no ORM, no table definitions. You own
  your schema and project it onto `MatchableEvent` / `UserProfile`.
- **No auth, no authorization.** `match(userId, ...)` trusts the `userId` you
  hand it. Authenticate before you call.
- **No HTTP layer, no API, no deployment.** No server, no Docker, no config
  loading from the environment (except the Anthropic adapter's optional
  `ANTHROPIC_API_KEY` default). It is a library.
- **No UI, no notifications, no chat, no scheduling.** Creating an event does
  not tell anyone about it.
- **No input validation at the edge.** Past time windows, absurd durations and
  hostile strings are normalized defensively, not rejected with helpful errors.
  That is your API layer's job.
- **No timezone policy.** Relative phrases ("tonight", "at 7pm") and the
  time-of-day table resolve against the *process's* local time. If your users
  aren't in the server's timezone, you own the reconciliation.
- **No production storage.** The in-memory event repository, cache and
  idempotency store are reference/dev implementations. They do not survive a
  restart and are not shared across processes.
- **No learning.** Weights and the time-of-day table are hand-tuned constants,
  not fitted to data. They are exported so you can replace them once you have
  some.
