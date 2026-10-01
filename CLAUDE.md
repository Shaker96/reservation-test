# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

This is a timed (90 min) take-home coding exercise for a job application. The full spec is in `PROMPT.md` — treat it as the source of truth and re-read it before making design decisions. No code exists yet; build/run/test commands should be added here once `package.json` and the test setup exist.

The candidate must be able to explain every line in a follow-up code walkthrough, so prefer small, explicit, readable code over abstraction. The spec states extra features and elaborate architecture earn no credit.

## Required stack and deliverables

- Node.js + TypeScript + PostgreSQL, single endpoint `POST /reservations`.
- Executable schema and seed files (3 pools, one vehicle each: operator-a/economy/airport, operator-a/compact/airport, operator-b/economy/airport).
- Automated tests against a **real** PostgreSQL that assert persisted rows, not just HTTP responses.
- README covering the specific items listed in `PROMPT.md` (contention points with code references, lost-response and crash-before-commit behavior, a plausible bug and how it was checked, time spent, AI usage, limitations, top 3 production improvements).

## Agreed design

Correctness guarantees live in the database, not in application memory, so they hold across multiple processes:

- `UNIQUE (operator_id, external_booking_id)` — the idempotency key (operator derived from the bearer token, never trusted from the body).
- `EXCLUDE USING gist (pool_id WITH =, tstzrange(pickup_at, dropoff_at, '[)') WITH &&)` (needs `btree_gist`) — prevents overselling; half-open range makes back-to-back rentals legal.
- Request flow inside one transaction:
  1. `pg_advisory_xact_lock` on a hash of `operator:externalBookingId` to serialize same-key requests.
  2. Look up existing reservation by key. If found: identical payload → 200 with original ID; different → 409 `IDEMPOTENCY_CONFLICT`. This check must precede the availability check (spec requires idempotency conflict to take precedence).
  3. Otherwise insert; map exclusion violation `23P01` → 409 `NO_AVAILABILITY`.
  - The advisory lock exists because without it, a same-key/different-payload race on an overlapping period could surface `23P01` before `23505` and return the wrong error code.
- Rejected requests roll back, so they never reserve the booking key.
- Unexpected errors → generic 5xx; never leak DB error details. Error body shape: `{ "error": { "code", "message" } }`.

## Timestamps

- API accepts ISO 8601 strings only (fixed by spec). Validate with a regex requiring an explicit `Z` or `±hh:mm` offset **before** `new Date()`, because `Date` silently treats offset-less strings as local time. Also reject impossible dates (e.g. `2030-02-31`).
- Store as `timestamptz`. For idempotency payload comparison, compare instants via `getTime()`, not strings. Limit fractional seconds to ≤3 digits (JS `Date` is millisecond precision, `timestamptz` is microsecond).
- All other string fields are compared exactly (no trimming/case folding) when checking idempotency.

## Open decisions to document in README

- Order of 401 / 400 / 403 checks is not specified by the spec — pick one and state it.
- Likely follow-up change is capacity > 1, cancellations, or modifications; the exclusion constraint only works for capacity 1.
