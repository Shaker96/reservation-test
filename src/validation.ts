import { z } from "zod";

// ISO 8601 with a mandatory timezone (Z or ±hh:mm) and at most millisecond
// precision, which is what a JS Date can represent without losing data.
const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

/**
 * Parses a timestamp that carries an explicit timezone, or returns null.
 * The calendar check is needed because `new Date("2030-02-31T10:00:00Z")`
 * silently rolls over to March 3 instead of failing.
 */
export function parseTimestamp(value: string): Date | null {
  const match = ISO_WITH_OFFSET.exec(value);
  if (!match) return null;

  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as number[];
  if (month! < 1 || month! > 12 || day! < 1 || day! > daysInMonth(year!, month!)) return null;
  if (hour! > 23 || minute! > 59 || second! > 59) return null;
  if (match[7] !== undefined && (Number(match[7]) > 23 || Number(match[8]) > 59)) return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const nonBlank = z
  .string()
  .max(200)
  .refine((s) => s.trim().length > 0, "must not be blank");

const timestamp = z.string().transform((value, ctx) => {
  const date = parseTimestamp(value);
  if (!date) {
    // fatal: stop here, otherwise the object-level refine below runs on a non-Date.
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be ISO 8601 with an explicit timezone", fatal: true });
    return z.NEVER;
  }
  return date;
});

export const ReservationRequest = z
  .object({
    externalBookingId: nonBlank,
    operatorId: nonBlank,
    vehicleGroup: nonBlank,
    pickupLocation: nonBlank,
    dropoffLocation: nonBlank,
    pickupAt: timestamp,
    dropoffAt: timestamp,
    customer: z.object({
      name: nonBlank,
      email: z.string().max(200).email(),
    }),
  })
  .refine((r) => r.pickupAt.getTime() < r.dropoffAt.getTime(), {
    message: "must be after pickupAt",
    path: ["dropoffAt"],
  });

export type ReservationRequest = z.infer<typeof ReservationRequest>;
