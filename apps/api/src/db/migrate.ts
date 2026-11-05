import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, closeDb } from "./index.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/** Applies pending SQL migrations in file-name order, each in its own transaction. */
export async function migrate(opts: { reset?: boolean; quiet?: boolean } = {}) {
  const pool = db();
  if (opts.reset) await pool.simpleQuery("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await pool.simpleQuery("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const done = new Set((await pool.query("SELECT name FROM schema_migrations")).rows.map(r => r.name));
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    await pool.simpleQuery(`BEGIN;\n${sql}\nINSERT INTO schema_migrations (name) VALUES ('${f}');\nCOMMIT;`);
    if (!opts.quiet) console.log(`applied ${f}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate({ reset: process.argv.includes("--reset") })
    .then(closeDb)
    .catch(e => { console.error(e); process.exit(1); });
}
