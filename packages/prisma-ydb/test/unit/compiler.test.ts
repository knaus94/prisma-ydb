import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileHarness } from './harness.ts';

type Model = {
  where(filter: unknown): Model;
  include(name: string, select: (rows: Model) => Model): Model;
  select(...fields: string[]): Model;
  limit(count: number): Model;
  all(): Promise<unknown>;
  first(): Promise<unknown>;
  create(values: unknown): Promise<unknown>;
  createIfAbsent?(values: unknown): Promise<unknown>;
  update(values: unknown): Promise<unknown>;
  delete(): Promise<unknown>;
  upsert?(values: unknown): Promise<unknown>;
};

const relationSchema = [
  '// use prisma-8',
  'model Parent {',
  '  id String @id',
  '  name String',
  '  indexed Indexed[]',
  '  keyed Keyed[]',
  '  scanned Scanned[]',
  '}',
  'model Indexed {',
  '  id String @id',
  '  parentId String',
  '  parent Parent @relation(fields: [parentId], references: [id], index: false)',
  '  @@index([parentId], map: "indexed_parent")',
  '}',
  'model Keyed {',
  '  parentId String',
  '  seq Int',
  '  parent Parent @relation(fields: [parentId], references: [id], index: false)',
  '  @@id([parentId, seq])',
  '}',
  'model Scanned {',
  '  id String @id',
  '  parentId String',
  '  parent Parent @relation(fields: [parentId], references: [id], index: false)',
  '}',
].join('\n');

test('relation includes look children up by parent keys', async (context) => {
  const harness = await compileHarness(context, relationSchema);
  const Parent = harness.models['Parent'] as Model;

  await context.test('unordered pages keep the plain join', async () => {
    const sql = await harness.sql(() =>
      Parent.where({ name: 'x' })
        .include('indexed', (rows) => rows.select('id'))
        .limit(5)
        .all(),
    );
    assert.doesNotMatch(sql, /__prisma_ydb_keys|VIEW/);
  });

  await context.test(
    'secondary index on the foreign key reads VIEW',
    async () => {
      const sql = await harness.sql(() =>
        Parent.where({ name: 'x' })
          .include('indexed', (rows) => rows.select('id'))
          .all(),
      );
      assert.match(
        sql,
        /\$__prisma_ydb_keys_1 = SELECT DISTINCT `__prisma_ydb_key_0` AS `k` FROM \(SELECT /,
      );
      assert.match(sql, /\) AS `__prisma_ydb_parents`;/);
      assert.match(sql, /`Indexed` VIEW `indexed_parent`/);
      assert.match(sql, /`parentId` IN \$__prisma_ydb_keys_1/);
      assert.match(sql, /`Parent`\.`name` = \$p1/);
    },
  );

  await context.test('primary key prefix needs no VIEW', async () => {
    const sql = await harness.sql(() =>
      Parent.where({ id: 'p' })
        .include('keyed', (rows) => rows.select('seq'))
        .all(),
    );
    assert.doesNotMatch(sql, /VIEW/);
    assert.match(sql, /`parentId` IN \$__prisma_ydb_keys_1/);
  });

  await context.test('no key path keeps the plain grouped join', async () => {
    const sql = await harness.sql(() =>
      Parent.where({ id: 'p' })
        .include('scanned', (rows) => rows.select('id'))
        .all(),
    );
    assert.doesNotMatch(sql, /__prisma_ydb_keys/);
    assert.doesNotMatch(sql, /VIEW/);
    assert.match(sql, /LEFT JOIN \(SELECT /);
  });
});

const storeSchema = [
  '// use prisma-8',
  'model Event {',
  '  tenant Int',
  '  id String',
  '  at DateTime',
  '  payload Json?',
  '  @@id([tenant, id])',
  '  @@columnStore(minPartitions: 2)',
  '}',
  'model Note {',
  '  id String @id',
  '  text String',
  '}',
].join('\n');

test('column-store mutations emulate RETURNING by key', async (context) => {
  const harness = await compileHarness(context, storeSchema);
  const Event = harness.models['Event'] as Model;
  const Note = harness.models['Note'] as Model;

  await context.test('row tables keep RETURNING', async () => {
    const sql = await harness.sql(() => Note.create({ id: 'n', text: 't' }));
    assert.match(
      sql,
      /INSERT INTO `Note` \(`id`, `text`\) VALUES \(\$p1, \$p2\) RETURNING `id`, `text`$/,
    );
  });

  await context.test('insert reads the inserted keys back', async () => {
    const sql = await harness.sql(() =>
      Event.create({ tenant: 1, id: 'e', at: new Date(0), payload: null }),
    );
    assert.doesNotMatch(sql, /RETURNING/);
    assert.match(
      sql,
      /INSERT INTO `Event` \([^)]*\) VALUES \([^)]*\);\nSELECT `at`, `id`, `payload`, `tenant` FROM `Event` WHERE AsTuple\(`tenant`, `id`\) IN AsList\(AsTuple\(\$p1, \$p2\)\)$/,
    );
  });

  await context.test('update snapshots rows before writing them', async () => {
    const sql = await harness.sql(() =>
      Event.where({ tenant: 1 }).update({ payload: { ok: true } }),
    );
    assert.match(sql, /^\$__prisma_ydb_rows = SELECT \* FROM `Event` WHERE /m);
    assert.match(
      sql,
      /\nUPDATE `Event` SET `payload` = \$p\d+ WHERE [^\n]*;\nSELECT [^\n]* FROM \(SELECT `at`, `id`, \$p\d+ AS `payload`, `tenant` FROM \$__prisma_ydb_rows\) AS `__prisma_ydb_updated`$/,
    );
    assert.doesNotMatch(sql, /IN \$__prisma_ydb/);
  });

  await context.test('delete selects rows before deleting them', async () => {
    const sql = await harness.sql(() => Event.where({ tenant: 1 }).delete());
    assert.match(sql, /^\$__prisma_ydb_rows = SELECT \* FROM `Event` WHERE /m);
    assert.match(
      sql,
      /\nDELETE FROM `Event` WHERE [^\n]*;\nSELECT [^\n]* FROM \$__prisma_ydb_rows$/,
    );
  });
});

test('top-level index annotations and composite tuple-list lookups compile natively', async (context) => {
  const { ydbView, whereKeys } = await import('prisma-ydb/runtime');
  const harness = await compileHarness(
    context,
    [
      '// use prisma-8',
      'model Wallet {',
      '  userKey Uint64',
      '  userId String',
      '  kind Int',
      '  status String',
      '  @@id([userKey, userId, kind])',
      '  @@index([status, kind], map: "wallet_status")',
      '  @@index([status], map: "wallet_status_short")',
      '  @@index([status, userId], map: "wallet_status_tie")',
      '  @@index([kind, status], map: "wallet_kind_first")',
      '  @@index([kind, userId], map: "wallet_kind_second")',
      '}',
    ].join('\n'),
  );
  type Scope = Record<
    string,
    import('@prisma/orm-family-sql/relational-core/expression').Expression<
      import('@prisma/orm-family-sql/relational-core/expression').ScopeField
    >
  >;
  type Read = {
    where(filter: ((scope: Scope) => unknown) | Record<string, unknown>): Read;
    update(values: Record<string, unknown>): Promise<unknown>;
    delete(): Promise<unknown>;
    all(
      configure?: (
        meta: import('@prisma/orm-framework/components/runtime').MetaBuilder<'read'>,
      ) => void,
    ): Promise<unknown>;
  };
  const Wallet = harness.models['Wallet'] as Read;
  const viewed = await harness.sql(() =>
    Wallet.where({ status: 'open' }).all((meta) =>
      meta.annotate(ydbView('wallet_status')),
    ),
  );
  assert.match(viewed, /FROM `Wallet` VIEW `wallet_status`/);
  await assert.rejects(
    harness.sql(() => Wallet.all((meta) => meta.annotate(ydbView('missing')))),
    /Unknown or unsupported YDB index/,
  );
  const keyed = await harness.sql(() =>
    Wallet.where((scope) =>
      whereKeys(scope, [
        { userKey: 3198191471355371895n, userId: 'a', kind: 1 },
        { userKey: 18446744073709551615n, userId: 'b', kind: 2 },
      ]),
    ).all(),
  );
  assert.doesNotMatch(keyed, /VIEW/);
  assert.match(keyed, /DECLARE \$p1 AS List<Tuple<Uint64,\s*Utf8,\s*Int32>>/);
  assert.match(
    keyed,
    /AsTuple\(`Wallet`\.`userKey`, `Wallet`\.`userId`, `Wallet`\.`kind`\) IN \$p1/,
  );
  const empty = await harness.sql(() =>
    Wallet.where((scope) => whereKeys(scope, [])).all(),
  );
  assert.match(empty, /WHERE FALSE/);
  assert.doesNotMatch(empty, /DECLARE/);
  const indexed = await harness.sql(() =>
    Wallet.where((scope) =>
      whereKeys(scope, [{ status: 'open', kind: 1 }]),
    ).all(),
  );
  assert.match(indexed, /VIEW `wallet_status`/);
  const shortest = await harness.sql(() =>
    Wallet.where((scope) => whereKeys(scope, [{ status: 'open' }])).all(),
  );
  assert.match(shortest, /VIEW `wallet_status_short`/);
  const explicit = await harness.sql(() =>
    Wallet.where((scope) => whereKeys(scope, [{ status: 'open' }])).all(
      (meta) => meta.annotate(ydbView('wallet_status_tie')),
    ),
  );
  assert.match(explicit, /VIEW `wallet_status_tie`/);
  const tied = await harness.sql(() =>
    Wallet.where((scope) => whereKeys(scope, [{ kind: 1 }])).all(),
  );
  assert.match(tied, /VIEW `wallet_kind_first`/);
  await assert.rejects(
    harness.sql(() =>
      Wallet.where((scope) => whereKeys(scope, [{ userId: 'a' }])).all(),
    ),
    /primary key or index prefix/,
  );
  const updated = await harness.sql(() =>
    Wallet.where((scope) =>
      whereKeys(scope, [{ userKey: 1n, userId: 'a', kind: 1 }]),
    ).update({ status: 'done' }),
  );
  assert.match(updated, /UPDATE `Wallet`/);
  assert.match(updated, /WHERE.*`userKey`/);
  assert.doesNotMatch(updated, /VIEW/);
  const deleted = await harness.sql(() =>
    Wallet.where((scope) =>
      whereKeys(scope, [{ userKey: 1n, userId: 'a', kind: 1 }]),
    ).delete(),
  );
  assert.match(deleted, /DELETE FROM `Wallet`/);
  assert.doesNotMatch(deleted, /VIEW/);
});
