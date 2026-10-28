import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixture, quote } from './helpers.ts';

test('prepared rows execute on clients and live transaction contexts', async (context) => {
  const fixture = await createFixture(context, {
    schema: (table) =>
      `// use prisma-8\nmodel PreparedItem {\n id String @id\n value Int\n @@map("${table('PreparedItem')}")\n}\n`,
  });
  const { db } = fixture;
  await fixture.ddl(
    `CREATE TABLE ${quote(fixture.table('PreparedItem'))} (id Utf8 NOT NULL,\`value\` Int32 NOT NULL,PRIMARY KEY(id));`,
  );
  await db.orm.PreparedItem.create({ id: 'one', value: 1 });
  const byId = await db.prepare({ id: 'ydb/utf8@1' } as const, (params) =>
    db.orm.PreparedItem.where((row) => row.id.eq(params.id)).prepared.first(),
  );
  assert.equal((await byId.query(db, { id: 'one' }))?.value, 1);
  assert.equal((await byId.query(db.runtime(), { id: 'one' }))?.value, 1);
  const settled = await db.transaction(async (transaction) => {
    await transaction.orm.PreparedItem.where({ id: 'one' }).update({
      value: 2,
    });
    assert.equal((await byId.query(transaction, { id: 'one' }))?.value, 2);
    return transaction;
  });
  await assert.rejects(
    async () => byId.query(settled, { id: 'one' }),
    /settled/,
  );
  assert.equal((await byId.query(db, { id: 'one' }))?.value, 2);
  await db.close();
  await assert.rejects(async () => byId.query(db, { id: 'one' }), /closed/);
});
