import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { YdbChangeEvent } from 'prisma-ydb/runtime';
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
