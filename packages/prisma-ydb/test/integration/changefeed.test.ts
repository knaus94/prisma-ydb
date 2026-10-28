import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  YdbChangeEvent,
  YdbChangefeedPartition,
} from 'prisma-ydb/runtime';
import { createFixture } from './helpers.ts';

test(
  'db.changefeed decodes managed feed records with the model codecs',
  { timeout: 120_000 },
  async (context) => {
    const fixture = await createFixture(context, {
      schema: (table) =>
        [
          '// use prisma-8',
          'model Order {',
          '  id String @id',
          '  total Decimal(10, 2)',
          '  qty BigInt',
          '  placedAt DateTime',
          '  note String?',
          '  tags String[]',
          `  @@map("${table('Order')}")`,
          '  @@changefeed("history", mode: NewAndOldImages, format: Json, retention: "P1D", consumers: ["app"])',
          '}',
        ].join('\n'),
    });
    const { db } = fixture;
    const planned = await fixture.prisma([
      'migration',
      'plan',
      '--from',
      '@empty',
      '--name',
      'initial',
    ]);
    assert.equal(planned.code, 0, planned.stdout + planned.stderr);
    const migrated = await fixture.prisma(['db', 'migrate']);
    assert.equal(migrated.code, 0, migrated.stdout + migrated.stderr);

    const placedAt = new Date('2026-05-06T07:08:09.123Z');
    await db.orm.Order.create({
      id: 'o1',
      total: '10.50',
      qty: 3n,
      placedAt,
      note: null,
      tags: ['new'],
    });
    await db.orm.Order.where({ id: 'o1' }).update({ note: 'paid', qty: 4n });
    await db.orm.Order.where({ id: 'o1' }).delete();

    const events: YdbChangeEvent[] = [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      for await (const batch of db.changefeed('Order', {
        consumer: 'app',
        waitMs: 1_000,
        signal: controller.signal,
      })) {
        events.push(...batch.events);
        await batch.commit();
        if (events.length >= 3) break;
      }
    } finally {
      clearTimeout(timeout);
    }
    assert.equal(events.length, 3);
    const [created, updated, erased] = events;
    assert.equal(created?.kind, 'update');
    assert.deepEqual(created?.key, { id: 'o1' });
    assert.deepEqual(created?.newImage, {
      id: 'o1',
      total: '10.50',
      qty: 3n,
      placedAt,
      note: null,
      tags: ['new'],
    });
    assert.equal(created?.oldImage, undefined);
    assert.equal(updated?.oldImage?.note, null);
    assert.equal(updated?.newImage?.note, 'paid');
    assert.equal(updated?.newImage?.qty, 4n);
    assert.equal(erased?.kind, 'erase');
    assert.deepEqual(erased?.key, { id: 'o1' });
    assert.equal(erased?.oldImage?.note, 'paid');
    for (const event of events) {
      assert.equal(typeof event.offset, 'bigint');
      assert.equal(typeof event.partition, 'bigint');
      assert.ok(event.raw && typeof event.raw === 'object');
    }

    await assert.rejects(
      (async () => {
        for await (const _batch of db.changefeed('Order', {
          consumer: 'app',
          feed: 'missing',
        }))
          void _batch;
      })(),
      /declares no changefeed missing/,
    );
  },
);

test(
  'db.changefeed keeps 64-bit integers exact and reports partition events',
  { timeout: 120_000 },
  async (context) => {
    const fixture = await createFixture(context, {
      schema: (table) =>
        [
          '// use prisma-8',
          'model Wallet {',
          '  userKey Uint64',
          '  id String',
          '  delta BigInt',
          '  cap Uint64?',
          '  day Date',
          '  amount Decimal(22, 9)',
          '  limits BigInt[]',
          '  @@id([userKey, id])',
          `  @@map("${table('Wallet')}")`,
          '  @@changefeed("history", mode: NewAndOldImages, format: Json, retention: "P1D", consumers: ["app", "replay"])',
          '}',
        ].join('\n'),
    });
    const { db } = fixture;
    const output = (result: { stdout: string; stderr: string }) =>
      result.stdout + result.stderr;
    const planned = await fixture.prisma([
      'migration',
      'plan',
      '--from',
      '@empty',
      '--name',
      'initial',
    ]);
    assert.equal(planned.code, 0, output(planned));
    const migrated = await fixture.prisma(['db', 'migrate']);
    assert.equal(migrated.code, 0, output(migrated));

    // Every value below is beyond Number.MAX_SAFE_INTEGER or needs an exact form.
    const row = {
      userKey: 3198191471355371895n,
      id: 'w1',
      delta: -9007199254740993n,
      cap: 18446744073709551615n,
      day: '2026-01-02',
      amount: '1234567890123.123456789',
      limits: [9223372036854775807n, -1n],
    };
    await db.orm.Wallet.create(row);
    await db.orm.Wallet.where({ userKey: row.userKey, id: 'w1' }).update({
      delta: 9007199254740993n,
    });

    const starts: YdbChangefeedPartition[] = [];
    const committed: YdbChangefeedPartition[] = [];
    const events: YdbChangeEvent[] = [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      for await (const batch of db.changefeed('Wallet', {
        consumer: 'app',
        waitMs: 1_000,
        signal: controller.signal,
        onPartitionStart: (partition) => {
          starts.push(partition);
        },
        onCommitted: (partition) => {
          committed.push(partition);
        },
      })) {
        events.push(...batch.events);
        await batch.commit();
        if (events.length >= 2) break;
      }
    } finally {
      clearTimeout(timeout);
    }
    const [created, updated] = events;
    assert.deepEqual(created?.key, { userKey: 3198191471355371895n, id: 'w1' });
    assert.deepEqual(created?.newImage, row);
    assert.equal(updated?.oldImage?.delta, -9007199254740993n);
    assert.equal(updated?.newImage?.delta, 9007199254740993n);
    const raw = created?.raw as { key: unknown[]; newImage: { cap: unknown } };
    assert.deepEqual(raw.key, ['3198191471355371895', 'w1']);
    assert.equal(raw.newImage.cap, '18446744073709551615');
    assert.equal(starts.length, 1);
    assert.equal(starts[0]?.committedOffset, 0n);
    assert.equal(created?.partition, starts[0]?.partitionId);
    assert.equal(created?.partitionSessionId, starts[0]?.partitionSessionId);
    assert.ok(committed.some((partition) => partition.committedOffset === 2n));

    // A start position rewinds a consumer without touching its stored offset first.
    const replay: YdbChangeEvent[] = [];
    const replayController = new AbortController();
    const replayTimeout = setTimeout(() => replayController.abort(), 30_000);
    try {
      for await (const batch of db.changefeed('Wallet', {
        consumer: 'replay',
        waitMs: 1_000,
        signal: replayController.signal,
        onPartitionStart: () => ({ readOffset: 1n }),
      })) {
        replay.push(...batch.events);
        if (replay.length) break;
      }
    } finally {
      clearTimeout(replayTimeout);
    }
    assert.equal(replay[0]?.offset, 1n);
    assert.equal(replay[0]?.newImage?.delta, 9007199254740993n);

    // Hook exceptions end the iteration instead of disappearing in the SDK.
    const failing = new AbortController();
    const failingTimeout = setTimeout(() => failing.abort(), 30_000);
    try {
      await assert.rejects(
        (async () => {
          for await (const batch of db.changefeed('Wallet', {
            consumer: 'replay',
            waitMs: 500,
            signal: failing.signal,
            onPartitionStart: () => {
              throw new Error('partition hook failed');
            },
          }))
            void batch;
        })(),
        /partition hook failed/,
      );
    } finally {
      clearTimeout(failingTimeout);
    }
  },
);
