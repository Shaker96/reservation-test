import { createApp } from "./app.js";
import { createPool } from "./db.js";

const port = Number(process.env.PORT ?? 3000);
const db = createPool();

createApp(db).listen(port, () => {
  console.log(`Listening on http://localhost:${port}`);
});
