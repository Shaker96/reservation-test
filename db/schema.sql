-- Re-runnable: safe to apply to an existing database.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- One row per pool. Each pool holds exactly one vehicle.
CREATE TABLE IF NOT EXISTS pools (
  id            serial PRIMARY KEY,
  operator_id   text NOT NULL,
  vehicle_group text NOT NULL,
  location      text NOT NULL,
  UNIQUE (operator_id, vehicle_group, location)
);

CREATE TABLE IF NOT EXISTS reservations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id         text NOT NULL,
  external_booking_id text NOT NULL,
  pool_id             integer NOT NULL REFERENCES pools (id),
  vehicle_group       text NOT NULL,
  pickup_location     text NOT NULL,
  dropoff_location    text NOT NULL,
  pickup_at           timestamptz NOT NULL,
  dropoff_at          timestamptz NOT NULL,
  customer_name       text NOT NULL,
  customer_email      text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),

  -- Idempotency key: one booking per (operator, broker booking ID).
  CONSTRAINT reservations_booking_key UNIQUE (operator_id, external_booking_id),

  CONSTRAINT reservations_period_valid CHECK (pickup_at < dropoff_at),

  -- Capacity of one: no two reservations in the same pool may overlap.
  -- '[)' makes the period half-open, so back-to-back rentals are allowed.
  CONSTRAINT reservations_no_overlap EXCLUDE USING gist (
    pool_id WITH =,
    tstzrange(pickup_at, dropoff_at, '[)') WITH &&
  )
);
