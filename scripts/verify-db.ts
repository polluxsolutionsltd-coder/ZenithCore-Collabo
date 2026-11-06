// Verifies a ZenithCore database (after a restore, a failover or a migration):
// schema version, record counts and the integrity of the audit hash chain.
// Usage: DATABASE_URL=... node --import tsx scripts/verify-db.ts   (exit code 1 if the audit chain is broken)
import { db, closeDb } from "../apps/api/src/db/index.js";
import { verifyChain } from "../apps/api/src/modules/audit/audit.service.js";

const tables = ["users", "documents", "payment_orders", "ledger_entries", "receipts", "helpdesk_tickets", "payroll_runs", "audit_log"];
const out: Record<string, any> = {};
out.schema = (await db().query("SELECT MAX(name) AS v FROM schema_migrations")).rows[0].v;
for (const t of tables) out[t] = (await db().query(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n;
const ledger = (await db().query("SELECT COALESCE(SUM(debit) - SUM(credit), 0)::float8 AS diff FROM ledger_entries")).rows[0].diff;
out.ledgerBalanced = Math.abs(ledger) < 0.005;
out.audit = await verifyChain();
console.log(JSON.stringify(out, null, 2));
await closeDb();
process.exit(out.audit.valid && out.ledgerBalanced ? 0 : 1);
