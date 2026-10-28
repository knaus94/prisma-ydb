import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ydb, ydbTransactionRetryPolicy } from 'prisma-ydb/runtime';
import type { YdbDriverEvent } from 'prisma-ydb/driver';
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
  const transactionEvents: YdbDriverEvent[] = [];
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
      onEvent: (event) => {
        if (event.operation === 'transaction') transactionEvents.push(event);
        else events.push(event.operation + (event.success ? '' : '!'));
      },
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
    'commitWith commits the final ORM statement without a commit RPC',
    async () => {
      operations();
      const before = db.stats().paths.held;
      const result = await db.transaction(async (tx) => {
        await tx.orm.Account.where({ id: 'a' }).first();
        const updated = await tx.commitWith(() =>
          tx.orm.Account.where({ id: 'a' }).updateAll({ balance: 4 }),
        );
        assert.equal(tx.invalidated, true);
        return updated;
      });
      assert.ok(result);
      assert.deepEqual(operations(), ['begin', 'query', 'query']);
      const after = db.stats().paths.held;
      assert.equal(after.active, 0);
      assert.equal(after.total - before.total, 1);
      assert.equal(after.errors, before.errors);
      assert.equal(
        (await db.orm.Account.where({ id: 'a' }).first())?.balance,
        4,
      );
    },
  );

  await context.test(
    'commitWith preserves atomic ORM mutation scopes',
    async () => {
      operations();
      await db.transaction(async (tx) => {
        const updated = await tx.commitWith(() =>
          tx.orm.Account.where({ id: 'a' }).update({ balance: 40 }),
        );
        assert.equal(updated?.balance, 40);
        assert.equal(tx.invalidated, true);
      });
      const emitted = operations();
      assert.equal(emitted.at(-1), 'commit');
      assert.ok(emitted.filter((event) => event === 'query').length >= 1);
      assert.equal(
        (await db.orm.Account.where({ id: 'a' }).first())?.balance,
        40,
      );
    },
  );

  await context.test(
    'commitWith rejects zero or multiple statements',
    async () => {
      operations();
      await assert.rejects(
        db.transaction(async (tx) => tx.commitWith(() => undefined)),
        /at least one statement/,
      );
      assert.deepEqual(operations(), ['begin', 'rollback']);
      await assert.rejects(
        db.transaction(async (tx) =>
          tx.commitWith(async () => {
            await tx.orm.Account.where({ id: 'a' }).updateAll({ balance: 5 });
            await tx.orm.Account.where({ id: 'a' }).updateAll({ balance: 6 });
          }),
        ),
        /already been committed|exactly one/,
      );
      // The first statement carried the commit; rejecting later work cannot undo it.
      assert.deepEqual(operations(), ['begin', 'query']);
      assert.equal(
        (await db.orm.Account.where({ id: 'a' }).first())?.balance,
        5,
      );
    },
  );

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
        assert.equal(db.stats().paths.held.active, 1);
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
      assert.equal(db.stats().paths.held.active, 0);
      assert.ok(db.stats().paths.held.errors >= 1);
    },
  );
  await context.test(
    'a real conflict replays the callback and emits final-attempt stats',
    async () => {
      transactionEvents.length = 0;
      let attempts = 0;
      const retries: number[] = [];
      await db.transaction(
        async (tx) => {
          attempts++;
          await tx.orm.Account.where({ id: 'a' }).first();
          if (attempts === 1)
            await db.orm.Account.where({ id: 'a' }).updateAll({ balance: 100 });
          await tx.commitWith(() =>
            tx.orm.Account.where({ id: 'a' }).updateAll({ balance: 101 }),
          );
        },
        {
          retry: { policy: ydbTransactionRetryPolicy() },
          stats: 'basic',
          onRetry: (event) => retries.push(event.attempt),
        },
      );
      assert.equal(attempts, 2);
      assert.deepEqual(retries, [2]);
      assert.equal(transactionEvents.length, 1);
      const event = transactionEvents[0]!;
      assert.equal(event.success, true);
      assert.equal(event.attempt, 2);
      assert.ok(event.durationMs >= 0);
      assert.equal(event.transaction?.committed, true);
      assert.equal(event.transaction?.mode, 'serializable');
      assert.equal(event.transaction?.attempts, 2);
      assert.equal(event.transaction?.failures.length, 1);
      assert.equal(event.transaction?.failures[0]?.kind, 'conflict');
      assert.equal(event.transaction?.statements, 2);
      const stats = event.transaction?.stats;
      assert.ok(stats);
      assert.ok(stats.phases > 0);
      assert.ok(stats.affectedShards > 0);
      assert.ok(stats.maxAffectedShards > 0);
      assert.ok(stats.affectedShards >= stats.maxAffectedShards);
      assert.equal(typeof stats.cpuTimeUs, 'bigint');
      assert.equal(typeof stats.durationUs, 'bigint');
      const table = stats.tables.find((entry) => entry.name.endsWith(physical));
      assert.ok(table);
      assert.ok(table.partitionsCount > 0);
      assert.ok(table.readRows > 0n);
      assert.ok(table.updateRows > 0n);
    },
  );

  await context.test(
    'signal and overall budget cancel long attempts and roll back writes',
    async () => {
      for (const kind of ['signal', 'budget'] as const) {
        const controller = new AbortController();
        const reason = new Error('caller cancelled');
        let timer: ReturnType<typeof setTimeout> | undefined;
        let attemptSignal: AbortSignal | undefined;
        transactionEvents.length = 0;
        try {
          await assert.rejects(
            db.transaction(
              async (tx) => {
                attemptSignal = tx.signal;
                await tx.orm.Account.create({ id: kind, balance: 999 });
                if (kind === 'signal')
                  timer = setTimeout(() => controller.abort(reason), 10);
                await new Promise<void>((resolve) => {
                  if (tx.signal.aborted) resolve();
                  else
                    tx.signal.addEventListener('abort', () => resolve(), {
                      once: true,
                    });
                });
              },
              kind === 'signal'
                ? { signal: controller.signal }
                : { retry: { budgetMs: 1000 } },
            ),
            kind === 'signal'
              ? (error) => error === reason
              : { name: 'TimeoutError' },
          );
        } finally {
          clearTimeout(timer);
        }
        assert.equal(attemptSignal?.aborted, true);
        assert.equal(transactionEvents.length, 1);
        assert.equal(transactionEvents[0]?.success, false);
        assert.equal(transactionEvents[0]?.transaction?.committed, false);
        assert.equal(await db.orm.Account.where({ id: kind }).first(), null);
      }
    },
  );
});
