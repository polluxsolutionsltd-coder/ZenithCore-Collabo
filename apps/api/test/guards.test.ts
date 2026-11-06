/**
 * Regression guards for fixes made during the build (see the build brief, "Blocks").
 * If one of these fails, a change has re-introduced a known defect.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "./helpers.js";
import { canonical } from "../src/lib/security.js";

let app: Awaited<ReturnType<typeof startApp>>;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

test("arrays are sent to PostgreSQL as array literals, quotes, commas and NULLs intact (both drivers)", async () => {
  const { db } = await import("../src/db/index.js");
  const values = ["MINISTRY", 'say "hi"', "a,b", "back\\slash", null, "مرحبا", "{braces}"];
  const r = await db().query("SELECT $1::text[] AS a, array_length($1::text[], 1) AS n", [values]);
  assert.deepEqual(r.rows[0].a, values);
  assert.equal(r.rows[0].n, values.length);
  const ints = await db().query("SELECT $1::int[] AS a", [[1, 2, 3]]);
  assert.deepEqual(ints.rows[0].a, [1, 2, 3]);
});

test("canonical JSON: key order and undefined fields do not change the hash", () => {
  const a = canonical({ b: 2, a: 1, skip: undefined, nested: { y: [1, { z: undefined, w: "x" }], x: null } });
  const b = canonical({ nested: { x: null, y: [1, { w: "x" }] }, a: 1, b: 2 });
  assert.equal(a, b);
  // Golden value: changing canonical() breaks every existing audit chain. Never edit this line without a chain migration.
  assert.equal(a, '{"a":1,"b":2,"nested":{"x":null,"y":[1,{"w":"x"}]}}');
  assert.equal(canonical(new Date("2026-01-02T03:04:05Z")), '"2026-01-02T03:04:05.000Z"');
});

test("the audit chain verifies whatever the server's time zone", async () => {
  const admin = await app.as("admin");
  assert.equal((await admin.post("/api/rules", { key: "REJECTION_REASON_MIN", scope: null, value: { chars: 12 }, effectiveFrom: "2030-01-01" })).status, 200);
  const saved = process.env.TZ;
  try {
    for (const tz of ["UTC", "Asia/Damascus", "Africa/Nairobi", "America/Los_Angeles"]) {
      process.env.TZ = tz;
      const v = (await admin.get("/api/audit/verify")).body;
      assert.equal(v.valid, true, `chain invalid with TZ=${tz}`);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
});
