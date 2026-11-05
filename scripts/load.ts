// Data migration loader. Dry run by default; add --commit to load (all-or-nothing, audited).
// Usage: DATABASE_URL=... node --import tsx scripts/load.ts budget|employees <file.csv> [--commit]
import fs from "node:fs";
import { load } from "../apps/api/src/modules/loaders/loaders.service.js";
import { closeDb } from "../apps/api/src/db/index.js";

const [kind, file, flag] = process.argv.slice(2);
if (!["budget", "employees"].includes(kind) || !file) { console.error("Usage: load.ts budget|employees <file.csv> [--commit]"); process.exit(2); }
const r = await load(kind as any, fs.readFileSync(file, "utf8"), { commit: flag === "--commit", actor: `loader:${process.env.USER ?? "cli"}` });
console.log(`${r.kind}: ${r.rows} rows, ${r.valid} valid, ${r.errors.length} error(s) – ${r.committed ? "LOADED" : flag === "--commit" ? "NOT loaded (fix the errors first)" : "dry run, nothing changed"}`);
for (const e of r.errors.slice(0, 200)) console.log(`  line ${e.line}  ${e.field}  ${e.code}${e.value !== undefined ? `  "${e.value}"` : ""}`);
await closeDb();
process.exit(r.errors.length ? 1 : 0);
