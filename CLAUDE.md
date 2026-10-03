# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Context

Timed (90 min) take-home exercise for a job application. The spec is `PROMPT.md`: treat it as the source of truth. The candidate must explain every line in a follow-up walkthrough, so prefer small, explicit code over abstraction. The spec says extra features earn no credit. Keep the README's design explanations and test coverage lists in sync with the code.

## Commands

```bash
npm run db:up                           # PostgreSQL 16 via docker compose on localhost:5433
npm run db:setup                        # apply db/schema.sql + db/seed.sql (re-runnable)
npm start                               # server on :3000 (PORT to override)
npm test                                # vitest against real PostgreSQL (reservations_test DB, auto-created)
npx vitest run -t "<name substring>"    # single test / group
npm run typecheck
```

`DATABASE_URL` / `TEST_DATABASE_URL` override the defaults in `src/db.ts` / `test/global-setup.ts`.

## Architecture

All correctness lives in PostgreSQL so it holds across processes. One transaction in `src/reservations.ts`, with locks always taken in this order:

1. `pg_advisory_xact_lock` on `[operator, externalBookingId]` serializes same-key requests. The existing-row lookup comes right after it, **before** any availability check, so replays succeed and changed-payload conflicts take precedence. Relies on READ COMMITTED (a fresh snapshot per statement).
2. `SELECT ... FROM pools ... FOR UPDATE` serializes bookings of one pool. Without it, concurrent inserts deadlock inside the exclusion check (`40P01` → 500). This was observed and fixed; the burst test is its regression test.
3. INSERT. The `reservations_no_overlap` EXCLUDE constraint (`tstzrange '[)'`) is the real overselling guarantee; `23P01` → 409 `NO_AVAILABILITY`.

The HTTP layer (`src/app.ts`) does auth before JSON parsing, then zod validation, then the operator-mismatch check. Inventory is validated by pool lookup in the service.

## Gotchas

- Timestamps: `new Date()` accepts offset-less strings (as local time) and rolls over impossible dates (Feb 31 → Mar 3). `parseTimestamp` in `src/validation.ts` guards both. Max 3 fractional digits.
- Zod transform issues must be `fatal: true`, otherwise object-level refines run on non-Date values.
- Concurrency tests use two app instances with separate `pg` pools to stand in for two processes; they cannot force interleavings, so race regressions are caught probabilistically.
