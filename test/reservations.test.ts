import type { Express } from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPool } from "../src/db.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

// Two app instances with separate connection pools stand in for two application
// processes: they share nothing but PostgreSQL.
const dbA = createPool(TEST_DATABASE_URL);
const dbB = createPool(TEST_DATABASE_URL);
const appA = createApp(dbA);
const appB = createApp(dbB);

afterAll(async () => {
  await Promise.all([dbA.end(), dbB.end()]);
});

beforeEach(async () => {
  await dbA.query("TRUNCATE reservations");
});

const baseBody = {
  externalBookingId: "BROKER-1001",
  operatorId: "operator-a",
  vehicleGroup: "economy",
  pickupLocation: "airport",
  dropoffLocation: "airport",
  pickupAt: "2030-06-10T10:00:00Z",
  dropoffAt: "2030-06-12T10:00:00Z",
  customer: { name: "Alex Example", email: "alex@example.com" },
};

function booking(overrides: Record<string, unknown> = {}) {
  return { ...baseBody, ...overrides };
}

function post(body: unknown, token: string | null = "test-token-a", app: Express = appA) {
  const req = request(app).post("/reservations");
  if (token) req.set("Authorization", `Bearer ${token}`);
  return req.send(body as object);
}

async function rows() {
  const result = await dbA.query(
    `SELECT id, operator_id, external_booking_id, vehicle_group, pickup_at, dropoff_at,
            customer_name, customer_email
       FROM reservations ORDER BY created_at, id`,
  );
  return result.rows;
}

function statuses(responses: request.Response[]) {
  return responses.map((r) => r.status).sort();
}

describe("new bookings and retries", () => {
  it("creates a reservation and persists every field", async () => {
    const res = await post(booking());

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      reservationId: expect.any(String),
      externalBookingId: "BROKER-1001",
      operatorId: "operator-a",
    });
    expect(await rows()).toEqual([
      {
        id: res.body.reservationId,
        operator_id: "operator-a",
        external_booking_id: "BROKER-1001",
        vehicle_group: "economy",
        pickup_at: new Date("2030-06-10T10:00:00Z"),
        dropoff_at: new Date("2030-06-12T10:00:00Z"),
        customer_name: "Alex Example",
        customer_email: "alex@example.com",
      },
    ]);
  });

  it("replays an identical retry with the original ID, even though the vehicle is now occupied", async () => {
    const first = await post(booking());
    const retry = await post(booking());

    expect(retry.status).toBe(200);
    expect(retry.body.reservationId).toBe(first.body.reservationId);
    expect(await rows()).toHaveLength(1);
  });

  it("treats reordered properties and equivalent timestamps as identical", async () => {
    const first = await post(booking());
    const { customer, ...rest } = booking({
      pickupAt: "2030-06-10T12:00:00+02:00",
      dropoffAt: "2030-06-12T10:00:00.000Z",
    });
    const retry = await post({ customer: { email: customer.email, name: customer.name }, ...rest });

    expect(retry.status).toBe(200);
    expect(retry.body.reservationId).toBe(first.body.reservationId);
  });

  it.each([
    ["customer email", { customer: { name: "Alex Example", email: "other@example.com" } }],
    ["customer name case", { customer: { name: "alex example", email: "alex@example.com" } }],
    ["vehicle group", { vehicleGroup: "compact" }],
    ["dates on a free period", { pickupAt: "2031-01-01T10:00:00Z", dropoffAt: "2031-01-02T10:00:00Z" }],
    ["dropoff time by one second", { dropoffAt: "2030-06-12T10:00:01Z" }],
  ])("returns IDEMPOTENCY_CONFLICT for a changed %s and keeps the original", async (_label, change) => {
    const first = await post(booking());
    const before = await rows();

    const changed = await post(booking(change));

    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await rows()).toEqual(before);
    expect(before[0].id).toBe(first.body.reservationId);
  });

  it("does not reserve the booking key when a request is rejected", async () => {
    await post(booking({ externalBookingId: "OTHER" }));

    const rejected = await post(booking());
    expect(rejected.body.error.code).toBe("NO_AVAILABILITY");

    const later = await post(booking({ pickupAt: "2031-01-01T10:00:00Z", dropoffAt: "2031-01-02T10:00:00Z" }));
    expect(later.status).toBe(201);
    expect(await rows()).toHaveLength(2);
  });
});

describe("overlap boundaries", () => {
  // Existing reservation: [2030-06-10T10:00Z, 2030-06-12T10:00Z)
  it.each([
    ["ends exactly at pickup", "2030-06-08T10:00:00Z", "2030-06-10T10:00:00Z", 201],
    ["starts exactly at dropoff", "2030-06-12T10:00:00Z", "2030-06-14T10:00:00Z", 201],
    ["starts at dropoff, expressed in another offset", "2030-06-12T12:00:00+02:00", "2030-06-14T10:00:00Z", 201],
    ["overlaps the start", "2030-06-09T10:00:00Z", "2030-06-10T10:00:01Z", 409],
    ["overlaps the end", "2030-06-12T09:59:59Z", "2030-06-13T10:00:00Z", 409],
    ["is contained", "2030-06-11T00:00:00Z", "2030-06-11T01:00:00Z", 409],
    ["contains it", "2030-06-01T00:00:00Z", "2030-06-30T00:00:00Z", 409],
    ["is the same period", "2030-06-10T10:00:00Z", "2030-06-12T10:00:00Z", 409],
  ])("a second booking that %s → %i", async (_label, pickupAt, dropoffAt, expected) => {
    await post(booking());

    const res = await post(booking({ externalBookingId: "BROKER-2", pickupAt, dropoffAt }));

    expect(res.status).toBe(expected);
    if (expected === 409) expect(res.body.error.code).toBe("NO_AVAILABILITY");
    expect(await rows()).toHaveLength(expected === 201 ? 2 : 1);
  });

  it("keeps pools independent: economy and compact can both be booked for the same period", async () => {
    const economy = await post(booking());
    const compact = await post(booking({ externalBookingId: "BROKER-2", vehicleGroup: "compact" }));

    expect([economy.status, compact.status]).toEqual([201, 201]);
  });
});

describe("concurrency across two app instances", () => {
  it("different IDs competing for one vehicle: one 201, one NO_AVAILABILITY, one row", async () => {
    const responses = await Promise.all([
      post(booking({ externalBookingId: "BROKER-1" }), "test-token-a", appA),
      post(booking({ externalBookingId: "BROKER-2", pickupAt: "2030-06-11T10:00:00Z" }), "test-token-a", appB),
    ]);

    expect(statuses(responses)).toEqual([201, 409]);
    expect(responses.find((r) => r.status === 409)!.body.error.code).toBe("NO_AVAILABILITY");
    expect(await rows()).toHaveLength(1);
  });

  // Regression: without the pool row lock, bursts like this deadlocked inside
  // the exclusion check and some requests got 500 instead of NO_AVAILABILITY.
  it("bursts of 20 different IDs for one vehicle: exactly one 201, the rest NO_AVAILABILITY", async () => {
    for (let round = 0; round < 5; round++) {
      await dbA.query("TRUNCATE reservations");
      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          post(booking({ externalBookingId: `BROKER-${i}` }), "test-token-a", i % 2 ? appA : appB),
        ),
      );

      expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
      expect(responses.filter((r) => r.body.error?.code === "NO_AVAILABILITY")).toHaveLength(19);
      expect(await rows()).toHaveLength(1);
    }
  });

  it("identical requests: one 201, one 200, same reservation ID, one row", async () => {
    const responses = await Promise.all([post(booking(), "test-token-a", appA), post(booking(), "test-token-a", appB)]);

    expect(statuses(responses)).toEqual([200, 201]);
    expect(responses[0]!.body.reservationId).toBe(responses[1]!.body.reservationId);
    expect(await rows()).toHaveLength(1);
  });

  it("same booking ID for economy and compact: one 201, one IDEMPOTENCY_CONFLICT, one row", async () => {
    const responses = await Promise.all([
      post(booking({ vehicleGroup: "economy" }), "test-token-a", appA),
      post(booking({ vehicleGroup: "compact" }), "test-token-a", appB),
    ]);

    expect(statuses(responses)).toEqual([201, 409]);
    expect(responses.find((r) => r.status === 409)!.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    const persisted = await rows();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe(responses.find((r) => r.status === 201)!.body.reservationId);
  });
});

describe("tenant isolation", () => {
  const bodyB = booking({ operatorId: "operator-b" });

  it("allows the same booking ID and dates for different operators", async () => {
    const [a, b] = await Promise.all([post(booking(), "test-token-a"), post(bodyB, "test-token-b", appB)]);

    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.reservationId).not.toBe(b.body.reservationId);
    expect((await rows()).map((r) => r.operator_id).sort()).toEqual(["operator-a", "operator-b"]);
  });

  it("never returns another operator's reservation on retry", async () => {
    const a = await post(booking(), "test-token-a");
    const b = await post(bodyB, "test-token-b");

    expect(b.status).toBe(201);
    expect(b.body.reservationId).not.toBe(a.body.reservationId);
    expect(b.body.operatorId).toBe("operator-b");
  });

  it("rejects a token/body operator mismatch with 403 and stores nothing", async () => {
    const res = await post(booking(), "test-token-b");

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(await rows()).toHaveLength(0);
  });
});

describe("authentication", () => {
  it.each([
    ["missing", null],
    ["unknown", "test-token-c"],
    ["inherited object property", "constructor"],
  ])("rejects a %s token with 401", async (_label, token) => {
    const res = await post(booking(), token);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a non-Bearer scheme with 401", async () => {
    const res = await request(appA).post("/reservations").set("Authorization", "Basic test-token-a").send(booking());
    expect(res.status).toBe(401);
  });
});

describe("validation", () => {
  const { customer: _customer, ...withoutCustomer } = baseBody;

  it.each([
    ["missing field", withoutCustomer],
    ["number instead of string", booking({ externalBookingId: 1001 })],
    ["blank string", booking({ externalBookingId: "   " })],
    ["invalid email", booking({ customer: { name: "Alex", email: "not-an-email" } })],
    ["blank customer name", booking({ customer: { name: "", email: "alex@example.com" } })],
    ["timestamp without timezone", booking({ pickupAt: "2030-06-10T10:00:00" })],
    ["date-only timestamp", booking({ pickupAt: "2030-06-10" })],
    ["impossible date (Feb 31)", booking({ pickupAt: "2030-02-31T10:00:00Z", dropoffAt: "2030-03-05T10:00:00Z" })],
    ["sub-millisecond precision", booking({ pickupAt: "2030-06-10T10:00:00.0001Z" })],
    ["pickup equal to dropoff", booking({ dropoffAt: "2030-06-10T10:00:00Z" })],
    ["pickup after dropoff", booking({ pickupAt: "2030-06-13T10:00:00Z" })],
    ["unsupported vehicle group", booking({ vehicleGroup: "luxury" })],
    ["unsupported location", booking({ pickupLocation: "downtown", dropoffLocation: "downtown" })],
    ["non-airport dropoff", booking({ dropoffLocation: "downtown" })],
    ["location with different case", booking({ pickupLocation: "Airport", dropoffLocation: "Airport" })],
    ["non-object body", ["not", "an", "object"]],
  ])("rejects %s with 400 and stores nothing", async (_label, body) => {
    const res = await post(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_REQUEST");
    expect(await rows()).toHaveLength(0);
  });

  // Regression: everything except malformed JSON used to fall through to 500.
  it.each([
    ["malformed JSON", "application/json", '{"externalBookingId": '],
    ["a body over the 100 KB limit", "application/json", JSON.stringify(booking({ padding: "a".repeat(200_000) }))],
    ["an unknown charset", "application/json; charset=klingon", JSON.stringify(booking())],
  ])("rejects %s with 400, not 500", async (_label, contentType, rawBody) => {
    const res = await request(appA)
      .post("/reservations")
      .set("Authorization", "Bearer test-token-a")
      .set("Content-Type", contentType)
      .send(rawBody);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_REQUEST");
    expect(await rows()).toHaveLength(0);
  });

  it("accepts past dates", async () => {
    const res = await post(booking({ pickupAt: "2001-01-01T10:00:00Z", dropoffAt: "2001-01-02T10:00:00Z" }));
    expect(res.status).toBe(201);
  });
});

describe("unknown routes", () => {
  it.each([
    ["GET", "/reservations"],
    ["POST", "/other"],
  ])("%s %s returns 404 in the error shape", async (method, path) => {
    const res = await request(appA)[method === "GET" ? "get" : "post"](path).set("Authorization", "Bearer test-token-a");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "NOT_FOUND", message: expect.any(String) } });
  });
});

describe("infrastructure failures", () => {
  let unreachable: pg.Pool;

  afterAll(async () => {
    await unreachable?.end();
  });

  it("returns 500 without exposing database details", async () => {
    unreachable = createPool("postgres://postgres:postgres@localhost:1/nothing");
    const res = await post(booking(), "test-token-a", createApp(unreachable));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: "INTERNAL_ERROR", message: expect.any(String) } });
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|postgres|5432|localhost/i);
  });
});
