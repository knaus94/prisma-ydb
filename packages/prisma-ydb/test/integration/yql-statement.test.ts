import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  yqlModel,
  yqlStatement,
  ydbUuid,
  ydbInt64,
  ydbDecimal,
  optional,
  list,
  struct,
} from 'prisma-ydb/runtime';
import { createFixture, quote } from './helpers.ts';

test('typed YQL statements encode native containers and share client transactions', async (context) => {
  const fixture = await createFixture(context, {
    schema: (table) =>
      `// use prisma-8\nmodel Item {\n id String @id @map("item_id")\n at DateTime\n @@map("${table('Item')}")\n}`,
  });
  const { db } = fixture;
  await fixture.ddl(
    `CREATE TABLE ${quote(fixture.table('Item'))} (item_id Utf8 NOT NULL, at Timestamp NOT NULL, PRIMARY KEY (item_id));`,
  );
  const item = yqlModel(db.contract, 'Item', { micros: ['at'] });
  const write = yqlStatement({
    params: { rows: list(item) },
    results: {},
    text: `UPSERT INTO ${item.table} SELECT * FROM AS_TABLE($rows);`,
  });
  const micros = 1_767_323_045_123_456n;
  await db.transaction(async (tx) => {
    await write(tx, { rows: [{ id: 'one', at: micros }] });
    const read = yqlStatement({
      params: {},
      results: { items: item },
      text: `SELECT * FROM ${item.table};`,
    });
    assert.deepEqual(await read(tx, {}), {
      items: [{ id: 'one', at: micros }],
    });
  });
  const containers = yqlStatement({
    params: {
      id: optional(ydbUuid),
      rows: list(struct({ n: ydbInt64 })),
      amount: ydbDecimal.with(12, 2),
    },
    results: {
      nullable: { id: optional(ydbUuid), amount: ydbDecimal.with(12, 2) },
      empty: { n: ydbInt64 },
    },
    text: 'SELECT $id AS id, $amount AS amount; SELECT n FROM AS_TABLE($rows);',
  });
  assert.deepEqual(
    await containers(db, { id: null, rows: [], amount: '12.50' }),
    {
      nullable: [{ id: null, amount: '12.50' }],
      empty: [],
    },
  );
  const wrong = yqlStatement({
    params: {},
    results: {},
    text: 'SELECT 1 AS n;',
  });
  await assert.rejects(wrong(db, {}), /result-set count mismatch/);
});
