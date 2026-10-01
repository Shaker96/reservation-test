# Reservation Service

A single `POST /reservations` endpoint built with Node.js, TypeScript and PostgreSQL. It must stay correct under retries, concurrent requests and multiple tenants.

> Work in progress. Sections marked _TODO_ will be filled in as the implementation lands.

## Setup

_TODO_

## Run

_TODO_

## Test

_TODO_

## API

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
  "customer": { "name": "Alex Example", "email": "alex@example.com" }
}
```

| Scenario | Response |
| --- | --- |
| New booking | `201` |
| Identical retry | `200`, original `reservationId` |
| Same key, changed payload | `409 IDEMPOTENCY_CONFLICT` |
| Overlapping period in the same pool | `409 NO_AVAILABILITY` |
| Invalid input or unsupported inventory | `400 INVALID_REQUEST` |
| Missing or invalid token | `401 UNAUTHORIZED` |
| Token/body operator mismatch | `403 FORBIDDEN` |

## Design

### Where competing requests wait, conflict or retry

_TODO_

### Database commits but the broker never receives the response

_TODO_

### Process stops before the transaction commits

_TODO_

### A plausible mistake that would break the guarantees

_TODO_

## Test coverage

### Tested

_TODO_

### Not verified

_TODO_

## Known limitations

_TODO_

## Top 3 production improvements

_TODO_

## Submission notes

- **Time spent:** _TODO_
- **AI tools used:** _TODO_
- **A verification or correction made to generated code:** _TODO_
