import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "./pool.js";

const url = process.env.TEST_DATABASE_URL ?? "postgresql://zc:zc@localhost:5432/zenithcore_test";

test("pg client: auth, params, types, errors, transactions", async () => {
  const pool = new Pool({ connectionString: url, max: 2 });
  const r = await pool.query("SELECT $1::int AS n, $2::text AS s, $3::jsonb AS j, true AS b, NULL AS z, 'مرحبا' AS ar",
    [42, "hello", { a: 1 }]);
  assert.deepEqual(r.rows[0], { n: 42, s: "hello", j: { a: 1 }, b: true, z: null, ar: "مرحبا" });

  await assert.rejects(pool.query("SELECT * FROM no_such_table"), (e: any) => e.code === "42P01");
  // connection still usable after an error
  assert.equal((await pool.query("SELECT 1 AS one")).rows[0].one, 1);

  const c = await pool.connect();
  await c.query("BEGIN");
  await c.query("CREATE TEMP TABLE t (x int)");
  const ins = await c.query("INSERT INTO t VALUES ($1), ($2)", [1, 2]);
  assert.equal(ins.rowCount, 2);
  await c.query("ROLLBACK");
  c.release();

  const many = await Promise.all(Array.from({ length: 20 }, (_, i) => pool.query("SELECT $1::int AS i", [i])));
  assert.deepEqual(many.map(m => m.rows[0].i), Array.from({ length: 20 }, (_, i) => i));
  await pool.end();
});

test("array literals are parsed", async () => {
  const { parseArray } = await import("./connection.js");
  assert.deepEqual(parseArray("{MINISTRY,VISA,HQ}"), ["MINISTRY", "VISA", "HQ"]);
  assert.deepEqual(parseArray('{"a b","c\\"d",NULL,"NULL"}'), ["a b", 'c"d', null, "NULL"]);
  assert.deepEqual(parseArray("{}"), []);
  assert.deepEqual(parseArray("{1,2,3}", x => parseInt(x, 10)), [1, 2, 3]);
});
