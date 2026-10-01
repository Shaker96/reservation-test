# Project Prompt: Reservation Endpoint

You are implementing a small car-rental reservation service. The goal is a **small, explainable implementation with sound guarantees** under retries, concurrency and tenant boundaries. Extra features and elaborate architecture earn no credit. Every line must be understandable and defensible in a 15-minute code walkthrough, which will also include reasoning about one small change to the requirements.

## Constraints

- **Time budget:** 90 minutes total, including tests and documentation. If something is unfinished at the limit, stop and document it.
- **Stack:** Node.js, TypeScript, PostgreSQL. Any framework or database library is allowed.
- Include **executable schema and seed files**.
- Out of scope: UI, real broker integration, outbound webhooks, deployment, CI pipeline, a full authentication system, cancellations, modifications, prices, holds, capacity greater than one.
- Docker Compose for PostgreSQL is optional.
- All data is synthetic and fictional.

## The endpoint

```
POST /reservations
Authorization: Bearer test-token-a
Content-Type: application/json
```

```json
{
  "externalBookingId": "BROKER-1001",
  "operatorId": "operator-a",
  "vehicleGroup": "economy",
  "pickupLocation": "airport",
  "dropoffLocation": "airport",
  "pickupAt": "2030-06-10T10:00:00Z",
  "dropoffAt": "2030-06-12T10:00:00Z",
  "customer": {
    "name": "Alex Example",
    "email": "alex@example.com"
  }
}
```

## Inventory and authorization

Seed exactly three independent pools. Each contains **exactly one vehicle**:

| Operator | Group | Location |
| --- | --- | --- |
| operator-a | economy | airport |
| operator-a | compact | airport |
| operator-b | economy | airport |

Hardcoded authentication fixture:

- `test-token-a` authorizes `operator-a`.
- `test-token-b` authorizes `operator-b`.

Rules:

- Derive the authorized operator **from the token**. Reject a request whose body `operatorId` differs from it.
- There is one fictional broker.
- Both `pickupLocation` and `dropoffLocation` must be `airport`.
- Only the seeded pools are supported.

## Guarantees the implementation must provide

### Input validation

Treat all input as untrusted. Every field shown in the example is required. Validate:

- Types, and that strings are non-blank.
- Basic email format.
- Supported inventory (operator, group and location must match a seeded pool).
- Timestamps must carry an **explicit timezone** (`Z` or `±hh:mm`). Reject offset-less strings and impossible dates.
- `pickupAt` must be strictly before `dropoffAt`. Dates do not need to be in the future.

### No overlapping reservations

- Rental periods are half-open: `[pickupAt, dropoffAt)`. A vehicle returned at 10:00 can be rented again at 10:00.
- Partial overlap and full containment both count as conflicts.

### Durable booking identity

The idempotency key is **(authorized operator, externalBookingId)**, regardless of vehicle group or rental dates.

### Consistent retry handling

- An identical retry of a successful request returns the **original reservation ID**.
- The same key with a different valid payload returns `IDEMPOTENCY_CONFLICT` and leaves the original untouched.
- Compare **every** business field. JSON property order does not matter. Timestamps representing the same instant are equivalent (`10:00:00Z` equals `12:00:00+02:00`). All other strings are compared exactly.
- A replay must succeed even though the original reservation now occupies the vehicle.
- For an existing key, a changed-payload conflict takes **precedence** over an availability conflict.
- Rejected requests must **not** permanently reserve the booking key.

### Safety across processes

Separate application processes sharing the same PostgreSQL database must never create duplicates or oversell a pool. In-memory locks are not sufficient.

### Tenant isolation

- Different operators may use the same `externalBookingId`.
- One operator's bookings must not affect another operator's availability, nor expose another operator's reservation.

## Required outcomes

Assume valid requests and initially available inventory unless stated otherwise.

| Scenario | Expected result |
| --- | --- |
| New booking | `201`; one committed reservation |
| Identical retry | `200`; original reservation ID |
| Same key, changed valid payload | `409 IDEMPOTENCY_CONFLICT`; original unchanged |
| Different IDs competing concurrently for the same pool and an overlapping period | One `201`, one `409 NO_AVAILABILITY`; one reservation |
| Identical requests arriving concurrently | One `201`, one `200`; same reservation ID |
| Same operator and booking ID arriving concurrently, one for economy and one for compact | One `201`, one `409 IDEMPOTENCY_CONFLICT`; exactly one reservation |
| Same booking ID and dates for different authorized operators | Both may succeed independently |

Additional responses:

- `400 INVALID_REQUEST`: invalid input or unsupported inventory.
- `401 UNAUTHORIZED`: missing or invalid token.
- `403 FORBIDDEN`: token/body operator mismatch.
- An appropriate `5xx` for unexpected infrastructure failures.

Successful responses must contain `reservationId`, `externalBookingId` and `operatorId`.

Every error uses this shape (exact message wording is not assessed):

```json
{
  "error": {
    "code": "NO_AVAILABILITY",
    "message": "No vehicle is available for that period."
  }
}
```

Never expose database internals in responses.

## Chosen design

Enforce correctness in PostgreSQL, not in application memory, so it holds across processes.

**Schema**

- `pools`: the three seeded rows.
- `reservations`: id, operator, external booking id, pool, group, both locations, `pickup_at` / `dropoff_at` as `timestamptz`, customer name and email.
- `UNIQUE (operator_id, external_booking_id)`: the idempotency key.
- `EXCLUDE USING gist (pool_id WITH =, tstzrange(pickup_at, dropoff_at, '[)') WITH &&)` (requires the `btree_gist` extension): prevents overselling. The half-open range encodes the back-to-back rule.
- `CHECK (pickup_at < dropoff_at)`.

**Request flow**

1. Authenticate the token (`401`), validate the body (`400`), check the operator matches the token (`403`). The spec does not fix the order of these checks; pick one and document it.
2. Open a transaction.
3. `pg_advisory_xact_lock` on a hash of `operator:externalBookingId`, serializing requests that share a key.
4. Look up the reservation by key. If it exists: identical payload → `200` with the original ID; different payload → `409 IDEMPOTENCY_CONFLICT`. This runs before any availability check to honor the precedence rule.
5. Otherwise insert. Map exclusion violation `23P01` → `409 NO_AVAILABILITY`.
6. Any other error → generic `5xx`.

Why the advisory lock: without it, two same-key requests with different payloads competing for the same pool and period can surface the exclusion violation before the unique violation, returning `NO_AVAILABILITY` where `IDEMPOTENCY_CONFLICT` is required. Rejected requests roll back, so the key is never left reserved.

**Timestamps**

- The API accepts ISO 8601 strings only. Check the explicit offset with a regex **before** calling `new Date()`, because `Date` treats offset-less strings as local time.
- Store as `timestamptz`. Compare instants with `getTime()` when checking idempotency.
- Allow at most 3 fractional-second digits: JS `Date` has millisecond precision, `timestamptz` has microsecond precision.

## Tests

Write a small automated suite against a **real PostgreSQL** database. Assert persisted rows as well as HTTP responses. Prioritize, in order:

1. Concurrent competition for one vehicle.
2. Concurrent identical requests.
3. Concurrent reuse of a booking ID across different groups.
4. Tenant isolation.
5. Overlap boundaries and changed-payload retries.

Clearly state which cases are tested and which remain unverified.

## README requirements

Explain briefly, describing **this** implementation rather than general definitions of transactions or idempotency:

- Where two competing requests are forced to wait, conflict or retry. Reference the relevant code and database mechanism.
- What happens if the database commits but the broker never receives the HTTP response.
- What happens if the process stops before the transaction commits.
- One plausible implementation mistake that would break the guarantees, and how it was checked.

Also include:

- Exact setup, run and test instructions.
- Time spent.
- AI tools used, or "none".
- One concrete verification or correction made to generated code, if applicable.
- Known limitations and the three highest-priority production improvements.

## Submission

A GitHub repository link containing source, schema/seed files, tests and the README above.
