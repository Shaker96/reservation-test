import express, { type ErrorRequestHandler, type RequestHandler, type Response } from "express";
import type pg from "pg";
import { operatorForAuthHeader } from "./auth.js";
import { createReservation } from "./reservations.js";
import { ReservationRequest } from "./validation.js";

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

// Runs before body parsing so a missing token is reported as 401 even if the body is malformed.
const authenticate: RequestHandler = (req, res, next) => {
  const operatorId = operatorForAuthHeader(req.header("authorization"));
  if (!operatorId) return sendError(res, 401, "UNAUTHORIZED", "Missing or invalid bearer token.");
  res.locals.operatorId = operatorId;
  next();
};

const handleErrors: ErrorRequestHandler = (err, _req, res, _next) => {
  // express.json() rejects unreadable bodies (malformed JSON, too large, unknown
  // charset...) with a 4xx error flagged `expose`. These are client errors: a
  // 5xx would tell the broker to retry a request that can never succeed.
  if (err?.expose === true && err.status >= 400 && err.status < 500) {
    return sendError(res, 400, "INVALID_REQUEST", `Request body could not be read: ${err.message}`);
  }
  console.error(err);
  sendError(res, 500, "INTERNAL_ERROR", "Unexpected error. The request may be retried.");
};

export function createApp(db: pg.Pool): express.Express {
  const app = express();

  // Check order: 401 (token) → 400 (body) → 403 (operator mismatch) → 400 (inventory).
  app.post("/reservations", authenticate, express.json(), async (req, res) => {
    const operatorId: string = res.locals.operatorId;

    const parsed = ReservationRequest.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      const field = issue.path.join(".") || "body";
      return sendError(res, 400, "INVALID_REQUEST", `${field}: ${issue.message}`);
    }
    if (parsed.data.operatorId !== operatorId) {
      return sendError(res, 403, "FORBIDDEN", "Token is not authorized for this operator.");
    }

    const result = await createReservation(db, operatorId, parsed.data);
    switch (result.kind) {
      case "created":
        return res.status(201).json(result.reservation);
      case "replayed":
        return res.status(200).json(result.reservation);
      case "idempotency_conflict":
        return sendError(res, 409, "IDEMPOTENCY_CONFLICT", "Booking ID was already used with a different payload.");
      case "no_availability":
        return sendError(res, 409, "NO_AVAILABILITY", "No vehicle is available for that period.");
      case "unsupported_inventory":
        return sendError(res, 400, "INVALID_REQUEST", "Unsupported operator, vehicle group or location.");
    }
  });

  app.use((_req, res) => sendError(res, 404, "NOT_FOUND", "Route not found."));
  app.use(handleErrors);
  return app;
}
