import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ydb } from 'prisma-ydb/runtime';
import { ydbBindingFromEnv } from 'prisma-ydb/environment';
import { Text, Int32 } from '@ydbjs/value/primitive';
import { createFixture, quote, requireEndpoint } from './helpers.ts';

test('interactive transactions: lazy begin, read-only mode, statement commit and held-session cap', async (context) => {
  const fixture = await createFixture(context, {
    schema: (table) =>
      `// use prisma-8\nmodel Account {\n id String @id\n balance Int\n @@map("${table('Account')}")\n}\n`,
  });
  const physical = fixture.table('Account');
  await fixture.ddl(
    `CREATE TABLE ${quote(physical)} (id Utf8 NOT NULL, balance Int32 NOT NULL, PRIMARY KEY (id));`,
  );
  const events: string[] = [];
  const db = ydb({
    contractJson: fixture.contractJson,
    binding: ydbBindingFromEnv(requireEndpoint()),
    verifyMarker: false,
    driverOptions: {
      maxSessions: 2,
      maxTransactionSessions: 1,
      queryTimeoutMs: 10_000,
      acquireTimeoutMs: 5_000,
      closeTimeoutMs: 5_000,
      onEvent: (event) =>
        events.push(event.operation + (event.success ? '' : '!')),
    },
  });
  context.after(() => db.close());
  await db.connect();
  const operations = () =>
    events.splice(0).filter((name) => name !== 'acquire');

  await context.test(
    'the server transaction starts with the first statement',
    async () => {
      await db.orm.Account.create({ id: 'a', balance: 1 });
      operations();
      const balance = await db.transaction(async (tx) => {
        await tx.yql(
          `DECLARE $id AS Utf8; DECLARE $balance AS Int32; UPDATE ${quote(physical)} SET balance = $balance WHERE id = $id`,
          { id: new Text('a'), balance: new Int32(2) },
        );
        return (await tx.orm.Account.where({ id: 'a' }).first())?.balance;
      });
      assert.equal(balance, 2);
      assert.deepEqual(operations(), ['begin', 'query', 'query', 'commit']);
      await db.transaction(async () => undefined);
      assert.deepEqual(operations(), ['begin', 'commit']);
    },
  );

  await context.test(
    'snapshot read-only transactions read but never write',
    async () => {
      const rows = await db.transaction(async (tx) => tx.orm.Account.all(), {
        mode: 'snapshotReadOnly',
      });
      assert.equal(rows.length, 1);
      await assert.rejects(
        db.transaction(
          async (tx) =>
            tx.orm.Account.where({ id: 'a' }).update({ balance: 9 }),
          { mode: 'snapshotReadOnly' },
        ),
      );
      assert.equal(
        (await db.orm.Account.where({ id: 'a' }).first())?.balance,
        2,
      );
    },
  );

  await context.test('a statement can carry the commit', async () => {
    const result = await db.transaction(async (tx) => {
      await tx.queryYql({
        text: `DECLARE $id AS Utf8; DECLARE $balance AS Int32; UPDATE ${quote(physical)} SET balance = $balance WHERE id = $id`,
        parameters: { id: new Text('a'), balance: new Int32(3) },
        commit: true,
      });
      await assert.rejects(
        tx.orm.Account.where({ id: 'a' }).first(),
        /already been committed/,
      );
      return 'done';
    });
    assert.equal(result, 'done');
    assert.equal((await db.orm.Account.where({ id: 'a' }).first())?.balance, 3);
  });

  await context.test(
    'held sessions are capped while autocommit statements proceed',
    async () => {
      let releaseFirst!: () => void;
      const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
      let firstStarted!: () => void;
      const started = new Promise<void>((resolve) => (firstStarted = resolve));
      const first = db.transaction(async (tx) => {
        await tx.orm.Account.all();
        firstStarted();
        await gate;
      });
      let second: Promise<unknown[]> | undefined;
      try {
        await started;
        assert.equal(db.stats().held, 1);
        let secondStarted = false;
        second = db.transaction(async (tx) => {
          secondStarted = true;
          return tx.orm.Account.all();
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(
          secondStarted,
          false,
          'the second transaction waits for a held slot',
        );
        // Autocommit traffic uses the session the held cap leaves free.
        assert.equal((await db.orm.Account.all()).length, 1);
      } finally {
        releaseFirst();
      }
      await first;
      assert.equal((await second!).length, 1);
      assert.equal(db.stats().held, 0);
    },
  );
});
