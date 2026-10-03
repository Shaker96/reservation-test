import { applySchema, createPool } from "../src/db.js";

const db = createPool();
await applySchema(db);
await db.end();
console.log("Schema and seed applied.");
