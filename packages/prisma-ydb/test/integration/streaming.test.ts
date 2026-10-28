import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ydb } from 'prisma-ydb/runtime';
import { ydbBindingFromEnv } from 'prisma-ydb/environment';
import { createFixture, quote, requireEndpoint } from './helpers.ts';

test('db.streaming yields rows beyond the buffered result bounds', async (context) => {
  const fixture = await createFixture(context, {
    schema: (table) =>
      `// use prisma-8\nmodel Row {\n id Int @id\n label String\n @@map("${table('Row')}")\n}\n`,
  });
  await fixture.ddl(
    `CREATE TABLE ${quote(fixture.table('Row'))} (id Int32 NOT NULL, label Utf8 NOT NULL, PRIMARY KEY (id));`,
  );
  await fixture.db.bulkUpsert(
    'Row',
    Array.from({ length: 300 }, (_, id) => ({ id, label: `row ${id}` })),
  );
  const db = ydb({
    contractJson: fixture.contractJson,
    binding: ydbBindingFromEnv(requireEndpoint()),
    verifyMarker: false,
    driverOptions: {
      maxSessions: 2,
      maxResultRows: 100,
      queryTimeoutMs: 10_000,
      closeTimeoutMs: 5_000,
    },
  });
  context.after(() => db.close());
  await db.connect();

  const before = db.stats().paths;
  await assert.rejects(
    async () => db.orm.Row.all(),
    /buffered result limit exceeded/,
  );

  assert.equal(db.stats().paths.autocommit.total - before.autocommit.total, 1);
  assert.equal(
    db.stats().paths.autocommit.errors - before.autocommit.errors,
    1,
  );
  assert.equal(db.stats().paths.autocommit.active, 0);

  const seen: number[] = [];
  for await (const row of db.streaming.orm.Row.all()) {
    assert.equal(db.stats().paths.streaming.active, 1);
    seen.push(row.id);
  }
  assert.equal(db.stats().paths.streaming.total - before.streaming.total, 1);
  assert.equal(db.stats().paths.streaming.errors, before.streaming.errors);
  assert.equal(db.stats().paths.streaming.active, 0);
  assert.equal(seen.length, 300);
  assert.equal(new Set(seen).size, 300);

  // Leaving the stream early cancels the RPC; the session is discarded, not reused.
  let taken = 0;
  for await (const row of db.streaming.orm.Row.all()) {
    assert.equal(typeof row.label, 'string');
    if (++taken === 1) break;
  }
  assert.equal(taken, 1);
  assert.equal(db.stats().paths.streaming.total - before.streaming.total, 2);
  assert.equal(db.stats().paths.streaming.errors, before.streaming.errors);
  assert.equal(
    db.stats().paths.streaming.abandoned - before.streaming.abandoned,
    1,
  );
  assert.equal(db.stats().paths.streaming.active, 0);
  // The abandoned session is deleted in the background; it never returns to the pool.
  const deadline = Date.now() + 5_000;
  while (db.stats().leased && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(db.stats().leased, 0);
  assert.equal((await db.orm.Row.where({ id: 5 }).first())?.label, 'row 5');
});
