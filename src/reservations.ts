import type pg from "pg";
import { isPgError } from "./db.js";
import type { ReservationRequest } from "./validation.js";

export interface Reservation {
  reservationId: string;
  externalBookingId: string;
  operatorId: string;
}

export type CreateReservationResult =
  | { kind: "created"; reservation: Reservation }
  | { kind: "replayed"; reservation: Reservation }
  | { kind: "idempotency_conflict" }
  | { kind: "no_availability" }
  | { kind: "unsupported_inventory" };

interface ReservationRow {
  id: string;
  operator_id: string;
  external_booking_id: string;
  vehicle_group: string;
  pickup_location: string;
  dropoff_location: string;
  pickup_at: Date;
  dropoff_at: Date;
  customer_name: string;
  customer_email: string;
}

/**
 * Creates a reservation for `operatorId`, the operator derived from the token.
 *
 * Concurrency is handled entirely by PostgreSQL so it holds across processes:
 * - A transaction-scoped advisory lock on (operator, externalBookingId) makes
 *   requests sharing a booking key run one after another.
 * - A row lock on the pool makes bookings for the same vehicle run one after
 *   another.
 * - The `reservations_no_overlap` exclusion constraint rejects an overlapping
 *   period at INSERT time; it holds even if the locks above were removed.
 */
export async function createReservation(
  db: pg.Pool,
  operatorId: string,
  request: ReservationRequest,
): Promise<CreateReservationResult> {
  // Both locations must be the pool's location: one-way rentals are not supported.
  if (request.dropoffLocation !== request.pickupLocation) return { kind: "unsupported_inventory" };

  const pool = await db.query<{ id: number }>(
    "SELECT id FROM pools WHERE operator_id = $1 AND vehicle_group = $2 AND location = $3",
    [operatorId, request.vehicleGroup, request.pickupLocation],
  );
  const poolId = pool.rows[0]?.id;
  if (poolId === undefined) return { kind: "unsupported_inventory" };

  const client = await db.connect();
  let connectionBroken = false;
  try {
    await client.query("BEGIN");

    // Waits here while another transaction holds the same booking key. The lock
    // is released by COMMIT/ROLLBACK, so once acquired, the SELECT below (a new
    // snapshot under READ COMMITTED) sees whatever the previous holder committed.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      JSON.stringify([operatorId, request.externalBookingId]),
    ]);

    const existing = await client.query<ReservationRow>(
      "SELECT * FROM reservations WHERE operator_id = $1 AND external_booking_id = $2",
      [operatorId, request.externalBookingId],
    );
    const row = existing.rows[0];
    if (row) {
      // Checked before availability: a replay must succeed even though the
      // original now occupies the vehicle, and a changed payload is a conflict.
      await client.query("ROLLBACK");
      return isSamePayload(row, request)
        ? { kind: "replayed", reservation: toReservation(row) }
        : { kind: "idempotency_conflict" };
    }

    // Waits here while another transaction is booking the same pool, so bookings
    // for one vehicle run one at a time. Without this row lock, concurrent
    // inserts can deadlock inside the exclusion constraint check (each waits on
    // the other's uncommitted index entry) and fail with 40P01 instead of 23P01.
    // Lock order is always booking key → pool, so the two locks cannot deadlock.
    await client.query("SELECT 1 FROM pools WHERE id = $1 FOR UPDATE", [poolId]);

    // The exclusion constraint is the guarantee: raises 23P01 on overlap.
    const inserted = await client.query<ReservationRow>(
      `INSERT INTO reservations (
         operator_id, external_booking_id, pool_id, vehicle_group, pickup_location,
         dropoff_location, pickup_at, dropoff_at, customer_name, customer_email
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        operatorId,
        request.externalBookingId,
        poolId,
        request.vehicleGroup,
        request.pickupLocation,
        request.dropoffLocation,
        request.pickupAt,
        request.dropoffAt,
        request.customer.name,
        request.customer.email,
      ],
    );
    await client.query("COMMIT");
    return { kind: "created", reservation: toReservation(inserted.rows[0]!) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      connectionBroken = true;
    });
    if (isPgError(err, "23P01")) return { kind: "no_availability" };
    throw err;
  } finally {
    // Discard the connection instead of returning it to the pool if it is broken.
    client.release(connectionBroken);
  }
}

/** Compares every business field. Timestamps are compared as instants. */
function isSamePayload(row: ReservationRow, request: ReservationRequest): boolean {
  return (
    row.vehicle_group === request.vehicleGroup &&
    row.pickup_location === request.pickupLocation &&
    row.dropoff_location === request.dropoffLocation &&
    row.pickup_at.getTime() === request.pickupAt.getTime() &&
    row.dropoff_at.getTime() === request.dropoffAt.getTime() &&
    row.customer_name === request.customer.name &&
    row.customer_email === request.customer.email
  );
}

function toReservation(row: ReservationRow): Reservation {
  return {
    reservationId: row.id,
    externalBookingId: row.external_booking_id,
    operatorId: row.operator_id,
  };
}
