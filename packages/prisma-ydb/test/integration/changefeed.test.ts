import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Json, Text, Uint64 } from '@ydbjs/value/primitive';
import type {
  YdbChangeEvent,
  YdbChangefeedPartition,
} from 'prisma-ydb/runtime';
import { createFixture, quote } from './helpers.ts';

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

test(
  'db.changefeed quarantines malformed records without blocking other partitions',
  { timeout: 120_000 },
  async (context) => {
    const fixture = await createFixture(context, {
      schema: (table) =>
        [
          '// use prisma-8',
          'model Event {',
          '  shard Uint64',
          '  id String',
          '  tags String[]',
          '  @@id([shard, id])',
          `  @@map("${table('Event')}")`,
          '  @@changefeed("history", mode: NewImage, format: Json, retention: "P1D", partitions: 2, autoPartitioning: false, consumers: ["app"])',
          '}',
        ].join('\n'),
    });
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
    // Native writes can violate the model's list encoding while remaining valid Json.
    await fixture.native.executeYql({
      text: `DECLARE $shard AS Uint64; DECLARE $id AS Utf8; DECLARE $tags AS Json; UPSERT INTO ${quote(fixture.table('Event'))} (shard, id, tags) VALUES ($shard, $id, $tags);`,
      parameters: {
        $shard: new Uint64(0n),
        $id: new Text('bad'),
        $tags: new Json('{}'),
      },
    });
    await fixture.db.orm.Event.where({ shard: 0n, id: 'bad' }).update({
      tags: [],
    });
    await fixture.db.orm.Event.create({
      shard: 18446744073709551615n,
      id: 'healthy-1',
      tags: [],
    });
    await fixture.db.orm.Event.where({
      shard: 18446744073709551615n,
      id: 'healthy-1',
    }).update({ tags: ['updated'] });

    const events: YdbChangeEvent[] = [];
    let failures = 0;
    let badPartition: bigint | undefined;
    for await (const batch of fixture.db.changefeed('Event', {
      consumer: 'app',
      waitMs: 500,
      signal: AbortSignal.timeout(30_000),
    })) {
      events.push(...batch.events);
      for (const partition of batch.partitions) {
        for (const failure of partition.errors) {
          failures++;
          badPartition = failure.partitionId;
          assert.equal(
            failure.partitionSessionId,
            partition.partitionSessionId,
          );
          assert.equal(failure.offset, 0n);
          assert.ok(failure.error instanceof TypeError);
          assert.match(failure.error.message, /not an array/);
          assert.match(new TextDecoder().decode(failure.payload), /tags/);
        }
        assert.ok(
          partition.events.every(
            (event) => event.partition === partition.partitionId,
          ),
        );
        if (partition.errors.length) await partition.commit();
      }
      await batch.commit();
      if (failures && events.length === 2) break;
    }
    assert.equal(failures, 1);
    assert.ok(events.every((event) => event.partition !== badPartition));
    assert.deepEqual(
      events.map((event) => event.key.id),
      ['healthy-1', 'healthy-1'],
    );

    // A deliberate skip also verifies the bad partition was never acknowledged.
    const starts: YdbChangefeedPartition[] = [];
    const resumed: YdbChangeEvent[] = [];
    for await (const batch of fixture.db.changefeed('Event', {
      consumer: 'app',
      waitMs: 500,
      signal: AbortSignal.timeout(30_000),
      onPartitionStart: (partition) => {
        starts.push(partition);
        return partition.partitionId === badPartition
          ? { commitOffset: 1n, readOffset: 1n }
          : undefined;
      },
    })) {
      resumed.push(...batch.events);
      await batch.commit();
      if (resumed.length) break;
    }
    assert.equal(
      starts.find((partition) => partition.partitionId === badPartition)
        ?.committedOffset,
      0n,
    );
    assert.equal(
      starts.find((partition) => partition.partitionId !== badPartition)
        ?.committedOffset,
      2n,
    );
    assert.ok(starts.every((partition) => !partition.retentionExpired));
    assert.deepEqual(
      resumed.map((event) => event.key.id),
      ['bad'],
    );
  },
);

test(
  'changefeed partition controls isolate delivery, skip poison and project fields',
  { timeout: 120_000 },
  async (context) => {
    const fixture = await createFixture(context, {
      schema: (table) =>
        [
          '// use prisma-8',
          'model Event {',
          '  shard Uint64',
          '  id String',
          '  note String',
          '  ignored String',
          '  @@id([shard, id])',
          `  @@map("${table('Event')}")`,
          '  @@changefeed("history", mode: NewImage, format: Json, retention: "P1D", partitions: 2, autoPartitioning: false, consumers: ["app", "probe"])',
          '}',
        ].join('\n'),
    });
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
    const { db } = fixture;
    const high = 18446744073709551615n;
    for (const [shard, id] of [
      [0n, 'bad'],
      [high, 'healthy-1'],
    ] as const) {
      await db.orm.Event.create({
        shard,
        id,
        note: 'first',
        ignored: 'wide payload',
      });
      await db.orm.Event.where({ shard, id }).update({ note: 'second' });
    }
    // Assignment ids are server-owned; discover the key-to-partition mapping first.
    const observed: YdbChangeEvent[] = [];
    for await (const batch of db.changefeed('Event', {
      consumer: 'probe',
      fields: [],
      waitMs: 100,
      signal: AbortSignal.timeout(30_000),
    })) {
      observed.push(...batch.events);
      if (observed.length === 4) break;
    }
    const refusedId = observed.find(
      (event) => event.key.shard === 0n,
    )!.partition!;
    assert.notEqual(
      refusedId,
      observed.find((event) => event.key.shard === high)!.partition,
    );

    let resumed = false;
    let refused: YdbChangefeedPartition | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const healthy: YdbChangeEvent[] = [];
    try {
      for await (const batch of db.changefeed('Event', {
        consumer: 'app',
        fields: ['note'],
        waitMs: 100,
        signal: AbortSignal.timeout(30_000),
        onPartitionStart(partition) {
          if (partition.partitionId === refusedId) {
            refused = partition;
            partition.stop('retention policy');
          } else {
            partition.pause();
            assert.equal(partition.paused, true);
            timer = setTimeout(() => {
              resumed = true;
              partition.resume();
            }, 200);
          }
        },
      })) {
        assert.equal(resumed, true);
        healthy.push(...batch.events);
        assert.ok(batch.events.every((event) => event.key.shard === high));
        await batch.commit();
        if (healthy.length === 2) break;
      }
    } finally {
      clearTimeout(timer);
    }
    assert.equal(refused?.stopped, true);
    assert.equal(refused?.stopReason, 'retention policy');
    assert.equal(healthy.length, 2);
    assert.deepEqual(healthy[0]?.newImage, {
      shard: high,
      id: 'healthy-1',
      note: 'first',
    });

    // A service can identify poison after decoding and checkpoint exactly through it.
    let poison: YdbChangeEvent | undefined;
    for await (const batch of db.changefeed('Event', {
      consumer: 'app',
      fields: [],
      partitionIds: [refusedId],
      waitMs: 100,
      signal: AbortSignal.timeout(30_000),
      onPartitionStart(partition) {
        assert.equal(partition.committedOffset, 0n);
      },
    })) {
      const partition = batch.partitions[0]!;
      poison = partition.events[0];
      assert.equal(poison?.offset, 0n);
      assert.deepEqual(poison?.newImage, { shard: 0n, id: 'bad' });
      await partition.skip(poison!);
      partition.stop('quarantine remaining events');
      await assert.rejects(
        partition.commit(),
        /Changefeed partition stopped: quarantine remaining events/,
      );
      await assert.rejects(
        partition.skip(poison!),
        /Changefeed partition stopped/,
      );
      await batch.commit();
      break;
    }
    let afterPoison: YdbChangeEvent | undefined;
    for await (const batch of db.changefeed('Event', {
      consumer: 'app',
      partitionIds: [refusedId],
      waitMs: 100,
      signal: AbortSignal.timeout(30_000),
      onPartitionStart(partition) {
        assert.equal(partition.committedOffset, 1n);
      },
    })) {
      const partition = batch.partitions[0]!;
      afterPoison = partition.events[0];
      partition.pause();
      assert.equal(partition.paused, true);
      partition.resume();
      assert.equal(partition.paused, false);
      await assert.rejects(partition.commitThrough(poison!), /does not belong/);
      await partition.commitThrough(afterPoison!);
      break;
    }
    assert.equal(afterPoison?.offset, 1n);
    assert.equal(afterPoison?.key.id, 'bad');
    assert.equal(afterPoison?.newImage?.note, 'second');
  },
);
