/**
 * D5 – security, low connectivity, monitoring, backup/restore and resilience
 * (20% of the demonstration score). Accessibility and the three languages are
 * covered by the browser rehearsals and the translation check in the build.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startApp, startCbs } from "./helpers.js";

const run = promisify(execFile);
let app: Awaited<ReturnType<typeof startApp>>;
let cbs: Awaited<ReturnType<typeof startCbs>>;
before(async () => { cbs = await startCbs(); app = await startApp(); });
after(async () => { await app.stop(); await cbs.stop(); });

test("offline capture: syncing the same request twice creates it once", async () => {
  const su = await app.as("su.health");
  const body = { budgetLineId: "0203-01-2221", supplierName: app.supplier.name, supplierIban: app.supplier.iban, description: "Captured offline at the clinic", amount: 75_000, clientRef: "offline-7d1f0a2b-0001" };
  const a = await su.post("/api/documents", body), b = await su.post("/api/documents", body);
  assert.equal(a.status, 200);
  assert.deepEqual([b.body.id, b.body.replay], [a.body.id, true]);
  assert.equal((await su.get("/api/documents")).body.filter((d: any) => d.description === body.description).length, 1);
});

test("security headers on API and web responses; no session without a valid token", async () => {
  for (const p of ["/api/health", "/"]) {
    const r = await fetch(app.base + p);
    assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'self'/, p);
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  }
  const forged = await fetch(app.base + "/api/me", { headers: { authorization: "Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOjF9." } });
  assert.equal(forged.status, 401);
});

test("monitoring: deep health and Prometheus metrics", async () => {
  const h = await fetch(app.base + "/api/health/deep").then(r => r.json());
  assert.equal(h.ready, true);
  assert.equal(h.checks.database.ok, true);
  assert.equal(h.checks.cbs.ok, true);
  assert.match(h.checks.schema, /^003_/);
  const m = await fetch(app.base + "/api/metrics").then(r => r.text());
  assert.match(m, /zc_http_requests_total\{method="GET",status="2xx"\} \d+/);
  assert.match(m, /zc_http_request_duration_seconds_bucket\{le="\+Inf"\} \d+/);
  assert.match(m, /zc_db_up 1/);

  const real = process.env.CBS_URL;
  process.env.CBS_URL = "http://127.0.0.1:9";
  const degraded = await fetch(app.base + "/api/health/deep").then(r => r.json());
  process.env.CBS_URL = real;
  assert.deepEqual([degraded.status, degraded.ready], ["degraded", true], "the bank link down degrades, it does not take ZenithCore down");
});

test("production refuses to start with demo settings or default secrets", async () => {
  const { unsafeSettings } = await import("../src/lib/config.js");
  assert.deepEqual(unsafeSettings({ NODE_ENV: "development" }), []);
  assert.equal(unsafeSettings({ NODE_ENV: "production", DEMO_MODE: "1", JWT_SECRET: "short" }).length, 4);
  assert.deepEqual(unsafeSettings({ NODE_ENV: "production", JWT_SECRET: "x".repeat(40), MOAD_API_KEY: "k", RECEIPT_SECRET: "r" }), []);
});

test("backup, tamper detection and verified restore into a clean database", { timeout: 90_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zc-backup-"));
  const root = path.resolve(import.meta.dirname, "../../..");
  const src = process.env.DATABASE_URL!;
  const target = src.replace(/\/[^/]+$/, "/zenithcore_restore_test");
  const admin = src.replace(/\/[^/]+$/, "/postgres");
  await run("psql", [admin, "-qc", "DROP DATABASE IF EXISTS zenithcore_restore_test"]);
  await run("psql", [admin, "-qc", "CREATE DATABASE zenithcore_restore_test"]);
  const live = (await (await app.as("auditor.cofc")).get("/api/audit/verify")).body; // before the backup
  const { stdout } = await run(path.join(root, "scripts/backup.sh"), [], { env: { ...process.env, DATABASE_URL: src, BACKUP_DIR: dir } });
  const file = stdout.trim();
  assert.ok(fs.existsSync(file) && fs.existsSync(file + ".sha256"));

  const r = await run(path.join(root, "scripts/restore.sh"), [file, target], { env: process.env, cwd: root });
  const report = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
  assert.equal(report.audit.valid, true);
  assert.equal(report.audit.entries, live.entries, "every audit entry restored");
  assert.equal(report.ledgerBalanced, true);

  await assert.rejects(run(path.join(root, "scripts/restore.sh"), [file, target], { env: process.env, cwd: root }), /not empty/, "no accidental overwrite");
  fs.appendFileSync(file, "x");
  await assert.rejects(run(path.join(root, "scripts/restore.sh"), [file, target, "--force"], { env: process.env, cwd: root }), /Checksum mismatch/);
  await run("psql", [admin, "-qc", "DROP DATABASE zenithcore_restore_test"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
