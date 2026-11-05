import { createServer } from "./server.js";
import { migrate } from "./db/migrate.js";

const port = Number(process.env.PORT ?? 8080);

await migrate({ quiet: true });
createServer().listen(port, () => console.log(`ZenithCore FMIS API on http://localhost:${port}`));
