import { readFile } from "node:fs/promises";
import pg from "pg";

export const DEFAULT_DATABASE_URL = "postgres://postgres:postgres@localhost:5433/reservations";

export function createPool(connectionString = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL): pg.Pool {
  return new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 });
}

/** Applies db/schema.sql and db/seed.sql. Both files are re-runnable. */
export async function applySchema(db: pg.Pool): Promise<void> {
  for (const file of ["schema.sql", "seed.sql"]) {
    const sql = await readFile(new URL(`../db/${file}`, import.meta.url), "utf8");
    await db.query(sql);
  }
}

export function isPgError(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}
