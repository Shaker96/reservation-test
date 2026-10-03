# Reservation Service

A single `POST /reservations` endpoint built with Node.js, TypeScript (Express 5, `pg`, `zod`) and PostgreSQL 16. It stays correct under retries, concurrent requests across processes, and multiple tenants. All guarantees are enforced by PostgreSQL, not by application memory.

## Setup

Requirements: Node.js 22+, Docker (for PostgreSQL).

```bash
npm install
npm run db:up      # starts PostgreSQL 16 on localhost:5433 (docker compose)
npm run db:setup   # applies db/schema.sql and db/seed.sql (both re-runnable)
```

To use another PostgreSQL instead of Docker, set `DATABASE_URL` (and `TEST_DATABASE_URL` for tests). The defaults are `postgres://postgres:postgres@localhost:5433/reservations` and `.../reservations_test`.

## Run

```bash
npm start          # http://localhost:3000, PORT to override
```

```bash
curl -i -X POST http://localhost:3000/reservations \
  -H "Authorization: Bearer test-token-a" -H "Content-Type: application/json" \
  -d '{"externalBookingId":"BROKER-1001","operatorId":"operator-a","vehicleGroup":"economy","pickupLocation":"airport","dropoffLocation":"airport","pickupAt":"2030-06-10T10:00:00Z","dropoffAt":"2030-06-12T10:00:00Z","customer":{"name":"Alex Example","email":"alex@example.com"}}'
```

## Test

```bash
npm test                                  # whole suite (needs npm run db:up)
npx vitest run -t "overlap boundaries"    # tests whose name matches
npm run typecheck
```

Tests run against a real PostgreSQL database, `reservations_test`, which `test/global-setup.ts` creates and migrates automatically. Each test truncates `reservations` first.

## Layout

| File | Purpose |
| --- | --- |
| [db/schema.sql](db/schema.sql) | Tables, idempotency `UNIQUE` key, overlap `EXCLUDE` constraint |
| [db/seed.sql](db/seed.sql) | The three pools |
| [src/reservations.ts](src/reservations.ts) | The transaction: locks, replay/conflict decision, insert |
| [src/validation.ts](src/validation.ts) | Request schema and strict timestamp parsing |
| [src/app.ts](src/app.ts) | HTTP layer: auth, status codes, error shape |
| [src/auth.ts](src/auth.ts) | Hardcoded token → operator fixture |

## API behavior

| Scenario | Response |
| --- | --- |
| New booking | `201` `{ reservationId, externalBookingId, operatorId }` |
| Identical retry | `200`, same body and original `reservationId` |
| Same key, changed payload | `409 IDEMPOTENCY_CONFLICT` |
| Overlapping period in the same pool | `409 NO_AVAILABILITY` |
| Invalid input, unreadable body (malformed JSON, over 100 KB, unknown charset) or unsupported inventory | `400 INVALID_REQUEST` |
| Missing or invalid token | `401 UNAUTHORIZED` |
| Token/body operator mismatch | `403 FORBIDDEN` |
| Unknown route or method | `404 NOT_FOUND` |
| Unexpected failure (e.g. database down) | `500 INTERNAL_ERROR`, no internals exposed |

Every error, including 404 and unreadable bodies, uses the shape `{ "error": { "code", "message" } }`.

Check order: token (401) → body shape (400) → operator match (403) → inventory (400) → idempotency (200/409) → availability (409). The spec does not fix the first three; authentication runs before JSON parsing so an unauthenticated caller always gets 401.

Decisions worth knowing:
- Unknown extra JSON properties are ignored, not rejected.
- Strings are stored and compared exactly: `"Airport"` is an unsupported location and `"Alex"` ≠ `"alex"`.
- Timestamps must match `YYYY-MM-DDTHH:MM:SS[.sss](Z|±HH:MM)`. More than 3 fractional digits are rejected, because JS `Date` would silently truncate them.

## Design

### Where competing requests wait, conflict or retry

Everything happens in one transaction in [`createReservation`](src/reservations.ts):

1. **Same booking key → wait.** `pg_advisory_xact_lock(hashtextextended([operator, externalBookingId]))` blocks the second request until the first commits or rolls back. Then, under READ COMMITTED, its `SELECT` takes a fresh snapshot and sees the committed row:
   - identical payload → `200` with the original ID;
   - different payload → `409 IDEMPOTENCY_CONFLICT`.

   This check runs **before** availability, which gives changed-payload conflicts precedence and lets replays succeed while the original occupies the vehicle. It also covers the economy-vs-compact case: they are different pools, so only the key lock can make them see each other.
2. **Same pool → wait.** `SELECT 1 FROM pools WHERE id = $1 FOR UPDATE` serializes bookings of one vehicle. Locks are always taken in the same order (key → pool), so they cannot deadlock each other.
3. **Overlap → conflict.** The `reservations_no_overlap` exclusion constraint (`gist`, `tstzrange(pickup_at, dropoff_at, '[)')`) raises `23P01`, which is mapped to `409 NO_AVAILABILITY`. This constraint is the actual guarantee against overselling; the pool lock exists so that conflicts surface as a clean `23P01` (see below).

Nothing retries automatically: a request either waits for a lock or gets a definitive answer. Tenants never wait on each other because pools and keys are both scoped by operator.

### Database commits but the broker never receives the response

The reservation exists. When the broker retries with the same payload, it waits on the key lock if needed, finds the row and gets `200` with the original `reservationId`. No duplicate is created and the vehicle stays booked. If the broker retries with a different payload, it gets `409 IDEMPOTENCY_CONFLICT`, because the first attempt is the one that counts.

### Process stops before the transaction commits

PostgreSQL rolls the transaction back when the connection drops, and the advisory lock and pool row lock are released with it. Nothing is persisted, so neither the booking key nor the vehicle stay reserved. The broker sees a network error, and its retry is processed as a new booking: `201`, or `409 NO_AVAILABILITY` if someone else took the vehicle meanwhile.

### A plausible mistake that would break the guarantees

**Relying only on the exclusion constraint for concurrent bookings.** That was my first version. It never oversold, but bursts of concurrent inserts into the same pool **deadlocked inside the exclusion check**: each transaction inserts its index entry and then waits for the other's uncommitted entry. PostgreSQL broke the cycle after `deadlock_timeout` (1 s) with `40P01`, so callers got `500` instead of `409 NO_AVAILABILITY`. I found it when the burst test failed once, and confirmed it with `deadlock detected` in the PostgreSQL logs. Adding the pool row lock fixed it. I then removed the lock again: the burst test (5 rounds × 20 concurrent requests) failed in 1 of 3 runs, so it catches the regression, though only probabilistically.

Other mistakes I checked by temporarily breaking the code:
- **Removing the advisory lock:** "same booking ID for economy and compact" failed in 3 of 3 runs. Both inserts succeeded on different pools, and one hit the unique key, which became a `500` instead of `IDEMPOTENCY_CONFLICT`.
- **Running the transaction at REPEATABLE READ** would also break step 1: the snapshot is taken by the lock statement before it waits, so the committed row would be invisible. This is reasoned, not tested.

## Test coverage

### Tested (52 tests, real PostgreSQL, HTTP responses and persisted rows)

- **Concurrency.** Two app instances with separate connection pools stand in for two processes:
  - different IDs for one vehicle;
  - bursts of 20 requests (5 rounds);
  - identical requests;
  - the same key for economy and compact.
- **Tenant isolation.** Same ID and dates for both operators both succeed. One operator's retry never returns the other's reservation. A token/body mismatch gets 403 and nothing is stored.
- **Idempotency:**
  - identical retry while the vehicle is occupied;
  - reordered JSON properties and equivalent timestamps (`+02:00` vs `Z`, `.000`) count as identical;
  - changed email, name casing, group, dates (including dates on a free period) and a 1-second dropoff change all give 409, with the original row unchanged;
  - a rejected request does not reserve the key.
- **Overlap boundaries:** back-to-back in both directions, including across offsets; partial overlap at both ends; contained; containing; identical period; independent pools.
- **Auth:** missing token, unknown token, `constructor` as a token (prototype lookup), non-Bearer scheme.
- **Validation:**
  - missing field, wrong type, blank strings, invalid email;
  - timestamp without timezone, date-only timestamp, Feb 31, sub-millisecond precision;
  - pickup ≥ dropoff;
  - unsupported group or location, non-airport dropoff, location casing;
  - non-object body, malformed JSON, body over 100 KB, unknown charset;
  - past dates are accepted.
- **Error shape:** unknown routes and methods give a JSON `404`, not Express's HTML page.
- **Infrastructure:** an unreachable database gives `500` with no connection details in the body.

Also checked manually: two real `src/server.ts` processes on different ports. 10 concurrent different IDs gave one `201` and nine `NO_AVAILABILITY`; 2 identical requests gave `201` and `200` with the same ID.

### Not verified

- Multi-process behavior is not part of the automated suite; it was checked once by hand, as described above.
- Concurrency tests cannot force a specific interleaving, so race regressions are caught probabilistically (see above).
- A crash between `COMMIT` and the response, and a crash mid-transaction, are reasoned about, not tested.
- Behavior under PostgreSQL failover, statement timeouts or pool exhaustion.

## Known limitations

- An unexpected unique violation (`23505`), which should be impossible while every writer takes the advisory lock, would surface as `500`.
- Bookings for one pool are fully serialized by the row lock. That is fine at capacity 1, but it is a throughput ceiling.
- Advisory-lock hash collisions between different keys only cause unnecessary waiting, never wrong results.
- No request timeout: a long lock wait holds the HTTP request open.
- Tokens, operators and inventory are fixtures; the error log goes to `console.error`.

## Top 3 production improvements

1. **Real authentication and authorization:** signed broker credentials mapped to operators, replacing the token fixture.
2. **Operational limits:** `lock_timeout`/`statement_timeout`, request timeouts, a pool size tuned to the database, and `503` with `Retry-After` when the database is unavailable.
3. **Observability and recovery:** structured logs with request and booking IDs, metrics for 409/5xx rates and lock waits, plus a read endpoint (`GET /reservations/:externalBookingId`) so a broker that lost a response can reconcile without re-posting.

## Submission notes

- **Time spent:** about 95 minutes of active work, measured from the Claude Code session logs, across three sittings:
  - **~40 min, initial build:** reading the spec, design, implementation, tests and README.
  - **~35 min, review:** walking through the code and the spec to make sure I can explain and defend every decision.
  - **~20 min, post-review fix:** while checking the error shape, I found that oversized bodies and unknown charsets returned `500` instead of `400`, and fixed it with tests. This work goes past the 90-minute limit; I chose to include it rather than leave a known bug.
- **AI tools used:** Claude Code (Claude Opus 5.5) for design discussion, implementation, tests and this README. I reviewed and verified the code as described below.
- **Verifications and corrections made to generated code:**
  - The first version caused `500`s under concurrent load because of exclusion-constraint deadlocks, which I confirmed in the PostgreSQL logs and fixed with the pool row lock (see above).
  - `new Date("2030-02-31T10:00:00Z")` silently becomes March 3. I confirmed this in Node and added explicit calendar validation.
  - Invalid timestamps returned `500` because zod still ran the object-level `pickupAt < dropoffAt` refine on the failed field; marking the issue `fatal` fixed it.
  - While checking the error shape, I probed Express's own failure paths. Bodies over 100 KB and unknown charsets returned `500`, which would make the broker retry a request that can never succeed, and unknown routes returned an HTML page. Now every 4xx from `express.json()` maps to `400 INVALID_REQUEST`, and there is a JSON `404`. The new tests fail against the old handler.
