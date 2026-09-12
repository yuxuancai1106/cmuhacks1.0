/**
 * Reference `EventRepository` implementation, backed by a `Map` in process
 * memory. Its job is to demonstrate the *correct concurrency semantics* the
 * interface demands — this is what the concurrency tests run against — so a
 * real (e.g. Postgres) implementation has an unambiguous contract to match.
 *
 * ## Equivalent SQL contract
 *
 * A relational implementation MUST perform the revalidate-and-join as a
 * single conditional statement, never a separate read followed by a write:
 *
 * ```sql
 * -- One statement: the WHERE clause IS the revalidation. If zero rows come
 * -- back, the caller failed one of NOT_OPEN / EXPIRED / FULL and must
 * -- re-derive which by re-reading the row (outside the write path).
 * UPDATE events
 *    SET participant_count = participant_count + 1,
 *        status = CASE WHEN participant_count + 1 >= capacity
 *                      THEN 'MATCHED' ELSE status END
 *  WHERE id = $1
 *    AND status = 'OPEN'
 *    AND expires_at > now()
 *    AND participant_count < capacity
 *  RETURNING *;
 *
 * -- Same transaction:
 * INSERT INTO participants (event_id, user_id) VALUES ($1, $2);
 * ```
 *
 * Plus a `UNIQUE (event_id, user_id)` constraint on the participants table as
 * a second line of defence against double-joins (e.g. a retried request).
 * `createEvent` must insert the event row and the creator's participant row
 * in that same transaction, so the event is never visible as OPEN with zero
 * recorded participants.
 *
 * **Read-count-then-insert is forbidden.** `SELECT participant_count ...`
 * followed by a separate `INSERT`/`UPDATE` loses races under concurrent
 * joins — two callers can both read `count < capacity` and both write. Only
 * the conditional `UPDATE ... WHERE ... RETURNING` above (or an equivalent
 * `SELECT ... FOR UPDATE` transaction) is safe.
 *
 * ## Indexes stage-1 retrieval needs
 * - `(status, expires_at, activity_id)`
 * - `(status, expires_at, category_id)`
 * - `(status, expires_at, location_id, start_time)`
 *
 * These match `CandidateQuery`'s predicates: status/expiry are always
 * filtered, activity/category is an OR'd equality probe, and
 * location/start_time supports the location scan plus window intersection.
 */
import { randomUUID } from 'node:crypto';
import type {
  CandidateQuery,
  EventDraft,
  EventId,
  EventRepository,
  JoinResult,
  MatchableEvent,
  UserId,
} from '../core/types.js';

/** Defensive copy so callers can never mutate our internal store through a returned reference. */
function cloneEvent(event: MatchableEvent): MatchableEvent {
  return {
    ...event,
    tags: [...event.tags],
    participantIds: event.participantIds ? [...event.participantIds] : undefined,
  };
}

function intervalsIntersect(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

export function createInMemoryEventRepository(opts?: {
  seed?: MatchableEvent[];
}): EventRepository & { all(): MatchableEvent[]; insert(e: MatchableEvent): void } {
  const store = new Map<EventId, MatchableEvent>();

  function insert(event: MatchableEvent): void {
    store.set(event.id, cloneEvent(event));
  }

  for (const event of opts?.seed ?? []) insert(event);

  function all(): MatchableEvent[] {
    return [...store.values()].map(cloneEvent);
  }

  async function findCandidates(query: CandidateQuery): Promise<MatchableEvent[]> {
    const results: MatchableEvent[] = [];

    for (const event of store.values()) {
      // Authoritative filters a real database would push into the WHERE
      // clause (see indexes above). Re-derived here since this Map has none.
      if (event.status !== 'OPEN') continue;
      if (!(event.expiresAt > query.now)) continue;
      if (!(event.participantCount < event.capacity)) continue;

      const activityMatch = query.activityIds.includes(event.activityId);
      const categoryMatch = query.categoryIds.includes(event.categoryId);
      if (!activityMatch && !categoryMatch) continue;

      if (!intervalsIntersect(event.startTime, event.endTime, query.windowStart, query.windowEnd)) {
        continue;
      }

      if (query.locationIds.length > 0 && !query.locationIds.includes(event.locationId)) {
        continue;
      }

      if (query.excludeUserId !== undefined) {
        if (event.creatorId === query.excludeUserId) continue;
        if (event.participantIds?.includes(query.excludeUserId)) continue;
      }

      results.push(cloneEvent(event));
      if (results.length >= query.limit) break;
    }

    return results;
  }

  async function joinEventAtomically(
    eventId: EventId,
    userId: UserId,
    now: Date,
  ): Promise<JoinResult> {
    // --- Atomic critical section: no `await` between the read and the write. ---
    // This function is declared `async` but never awaits anything, so its
    // entire body runs to completion synchronously the instant it is called
    // (JS only yields to other queued work at an `await`/microtask boundary).
    // Concretely: with capacity 4 and 3 existing participants, two concurrent
    // callers (e.g. via `Promise.all`) do not interleave their reads and
    // writes — the first call's synchronous run reads count=3, writes count=4
    // and flips status to MATCHED, and only *then* does the second call's
    // body run, at which point it reads the now-updated count=4 and fails
    // with FULL. Exactly one caller gets `ok: true`. A real database gets the
    // equivalent guarantee from the conditional `UPDATE` above.
    //
    // Check order matters for diagnosis, not just for correctness. Capacity is
    // tested BEFORE status precisely because filling the last slot also flips
    // status to MATCHED in the same write: checking status first would report
    // the loser of a final-slot race as NOT_OPEN and hide the real cause. The
    // caller retries the next candidate either way, but `match.join_conflict`
    // diagnostics and the §25 contract both want the accurate reason. EXPIRED
    // stays ahead of FULL because expiry is orthogonal to capacity — an
    // expired event is unjoinable however empty it is.
    const event = store.get(eventId);
    if (!event) return { ok: false, reason: 'NOT_FOUND' };
    if (event.participantIds?.includes(userId)) return { ok: false, reason: 'ALREADY_PARTICIPANT' };
    if (event.expiresAt <= now) return { ok: false, reason: 'EXPIRED' };
    if (event.participantCount >= event.capacity) return { ok: false, reason: 'FULL' };
    if (event.status !== 'OPEN') return { ok: false, reason: 'NOT_OPEN' };

    const participantIds = [...(event.participantIds ?? []), userId];
    const participantCount = event.participantCount + 1;
    const status = participantCount >= event.capacity ? 'MATCHED' : event.status;
    const updated: MatchableEvent = { ...event, participantIds, participantCount, status };
    store.set(eventId, updated);
    // --- End critical section. ---

    return { ok: true, event: cloneEvent(updated) };
  }

  async function createEvent(draft: EventDraft): Promise<MatchableEvent> {
    const event: MatchableEvent = {
      id: randomUUID(),
      creatorId: draft.creatorId,
      status: draft.status,
      activityId: draft.activityId,
      categoryId: draft.categoryId,
      tags: [...draft.tags],
      startTime: draft.startTime,
      endTime: draft.endTime,
      locationId: draft.locationId,
      capacity: draft.capacity,
      participantCount: 1,
      participantIds: [draft.creatorId],
      createdAt: draft.createdAt,
      expiresAt: draft.expiresAt,
    };
    // Synchronous set: the event (with its creator already enrolled) is
    // visible to the very next `findCandidates` call, same as a committed
    // insert would be to the next query in a real database.
    store.set(event.id, event);
    return cloneEvent(event);
  }

  return { findCandidates, joinEventAtomically, createEvent, all, insert };
}
