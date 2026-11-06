// Data migration loader. Dry run by default; add --commit to load (all-or-nothing, audited).
// Usage: DATABASE_URL=... node --import tsx scripts/load.ts budget|employees <file.csv> [--commit] [--old-pounds]
// --old-pounds: amounts in the file are in old Syrian pounds (before 1 Jan 2026, Decree 293/2025) and are converted on load.
import fs from "node:fs";
import { load } from "../apps/api/src/modules/loaders/loaders.service.js";
import { closeDb } from "../apps/api/src/db/index.js";

const [kind, file] = process.argv.slice(2);
const flags = process.argv.slice(4);
const flag = flags.includes("--commit") ? "--commit" : undefined;
if (!["budget", "employees"].includes(kind) || !file) { console.error("Usage: load.ts budget|employees <file.csv> [--commit]"); process.exit(2); }
const r = await load(kind as any, fs.readFileSync(file, "utf8"), { commit: flag === "--commit", actor: `loader:${process.env.USER ?? "cli"}`, oldPounds: flags.includes("--old-pounds") });
console.log(`${r.kind}: ${r.rows} rows, ${r.valid} valid, ${r.errors.length} error(s) – ${r.committed ? "LOADED" : flag === "--commit" ? "NOT loaded (fix the errors first)" : "dry run, nothing changed"}`);
if (r.conversion) for (const k of r.conversion.controls) console.log(`  converted ${k.field} from old pounds (÷${r.conversion.factor}, Decree ${r.conversion.decree}): ${k.oldTotal} old → ${k.newTotal} new (rounding ${k.rounding})`);
for (const e of r.errors.slice(0, 200)) console.log(`  line ${e.line}  ${e.field}  ${e.code}${e.value !== undefined ? `  "${e.value}"` : ""}`);
await closeDb();
process.exit(r.errors.length ? 1 : 0);
