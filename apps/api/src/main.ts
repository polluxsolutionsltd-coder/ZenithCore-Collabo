import { createServer } from "./server.js";
import { migrate } from "./db/migrate.js";
import { waitForDb } from "./db/index.js";
import { unsafeSettings } from "./lib/config.js";

const port = Number(process.env.PORT ?? 8080);

const problems = unsafeSettings();
if (problems.length) {
  console.error("Refusing to start in production:\n - " + problems.join("\n - "));
  process.exit(1);
}
await waitForDb({ log: m => console.warn(m) }); // the database may still be starting (reboot, container start)
await migrate({ quiet: true });
createServer().listen(port, () => console.log(`ZenithCore FMIS API on http://localhost:${port}`));
