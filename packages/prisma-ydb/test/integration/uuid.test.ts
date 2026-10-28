import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Uuid as SdkUuid } from '@ydbjs/value/primitive';
import { StatusIds_StatusCode } from '@ydbjs/api/operation';
import { and } from '@prisma/orm-family-sql/orm-client';
import { Uuid, UuidValue, Optional, List, Struct } from 'prisma-ydb/runtime';
import { introspectYdb, ydbControlTarget } from 'prisma-ydb/control';
import { createFixture, quote } from './helpers.ts';

const id = '00112233-4455-6677-8899-aabbccddeeff';
const alias = 'fedcba98-7654-3210-fedc-ba9876543210';
const nil = '00000000-0000-0000-0000-000000000000';
const last = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

test('native UUID identity, parameters and ordering', async (context) => {
  const fixture = await createFixture(context, {
    schema: (table) =>
      [
        '// use prisma-8',
        'model UuidItem {',
        '  tenant Int',
        '  id Uuid',
        '  alias Uuid @unique(map: "uuid_alias")',
        '  optional Uuid?',
        '  literal Uuid @default(uuid`00112233-4455-6677-8899-aabbccddeeff`)',
        '  label String',
        '  children UuidChild[]',
        '  @@id([tenant, id])',
        `  @@map("${table('UuidItem')}")`,
        '}',
        'model UuidChild {',
        '  id Uuid @id @default(uuid(7))',
        '  tenant Int',
        '  parentId Uuid',
        '  parent UuidItem @relation(fields: [tenant, parentId], references: [tenant, id], index: false)',
        '  @@index([tenant, parentId], map: "child_parent")',
        `  @@map("${table('UuidChild')}")`,
        '}',
      ].join('\n'),
  });
  const { db, native, table } = fixture;
  await fixture.ddl(
    `CREATE TABLE ${quote(table('UuidItem'))} (tenant Int32 NOT NULL,id Uuid NOT NULL,alias Uuid NOT NULL,\`optional\` Uuid,\`literal\` Uuid NOT NULL DEFAULT Uuid("${id}"),label Utf8 NOT NULL,PRIMARY KEY(tenant,id),INDEX uuid_alias GLOBAL UNIQUE SYNC ON(alias));`,
  );
  await fixture.ddl(
    `CREATE TABLE ${quote(table('UuidChild'))} (id Uuid NOT NULL,tenant Int32 NOT NULL,parentId Uuid NOT NULL,PRIMARY KEY(id),INDEX child_parent GLOBAL SYNC ON(tenant,parentId));`,
  );

  await context.test(
    'ORM round-trips UUIDs, nullable values and unique identity',
    async () => {
      assert.equal(Uuid, SdkUuid);
      assert.equal(new Uuid(id.replaceAll('-', '')).toString(), id);
      assert.throws(() => new UuidValue('not-a-uuid'), /Uuid requires/);
      assert.throws(
        () => new UuidValue(id.replaceAll('-', '')),
        /Uuid requires/,
      );
      const created = await db.orm.UuidItem.create({
        tenant: 1,
        id: id.toUpperCase(),
        alias: alias.toUpperCase(),
        optional: null,
        label: 'one',
      });
      assert.equal(created.id, id);
      assert.equal(created.alias, alias);
      assert.equal(created.optional, null);
      assert.equal(created.literal, id);
      await assert.rejects(async () =>
        db.orm.UuidItem.create({
          tenant: 1,
          id: 'invalid',
          alias: randomUUID(),
          optional: null,
          label: 'invalid',
        }),
      );
      const child = await db.orm.UuidChild.create({
        tenant: 1,
        parentId: id.toUpperCase(),
      });
      assert.match(
        child.id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      await db.orm.UuidItem.create({
        tenant: 1,
        id: nil,
        alias: last,
        optional: nil,
        label: 'nil',
      });
      await db.orm.UuidItem.where({ tenant: 1, id: id.toUpperCase() }).update({
        optional: alias.toUpperCase(),
      });
      assert.equal(
        (await db.orm.UuidItem.where({ tenant: 1, id }).first())?.optional,
        alias,
      );
      assert.equal(
        (
          await db.orm.UuidItem.where((row) =>
            row.id.in([id.toUpperCase(), nil]),
          ).all()
        ).length,
        2,
      );
      await db.orm.UuidItem.where({ tenant: 1, id }).update({ optional: null });
      assert.equal(
        (await db.orm.UuidItem.where({ tenant: 1, id }).first())?.optional,
        null,
      );
      await assert.rejects(
        db.orm.UuidItem.create({
          tenant: 2,
          id: randomUUID(),
          alias: alias.toUpperCase(),
          optional: null,
          label: 'duplicate',
        }),
        (error) =>
          error instanceof Error &&
          'status' in error &&
          error.status === StatusIds_StatusCode.PRECONDITION_FAILED,
      );
      assert.equal(
        (await db.orm.UuidItem.where({ label: 'duplicate' }).all()).length,
        0,
      );
      const indexed = await db.yql(
        `DECLARE $id AS Uuid; SELECT id FROM ${quote(table('UuidItem'))} VIEW uuid_alias WHERE alias=$id;`,
        { id: new UuidValue(alias.toUpperCase()) },
      );
      assert.equal(indexed[0]?.['id'], id);
      const related = await db.orm.UuidItem.where({ tenant: 1, id })
        .include('children', (rows) => rows.select('id', 'parentId'))
        .first();
      assert.equal(related?.children[0]?.id, child.id);
      assert.equal(related?.children[0]?.parentId, id);
    },
  );

  await context.test(
    'native optional, list and struct parameters preserve all UUID bits',
    async () => {
      const value = new UuidValue(id.toUpperCase());
      const result = await db.queryYql({
        text: `DECLARE $id AS Uuid; DECLARE $empty AS Uuid?; DECLARE $ids AS List<Uuid>; DECLARE $rows AS List<Struct<id:Uuid,maybe:Uuid?>>;
      SELECT $id AS id,$id=Uuid("${id}") AS literalMatches,$empty AS empty;
      SELECT $ids AS ids;
      SELECT id,maybe FROM AS_TABLE($rows);`,
        parameters: {
          id: value,
          empty: new Optional(null, value.type),
          ids: new List(value, new UuidValue(nil), new UuidValue(last)),
          rows: new List(
            new Struct({
              id: value,
              maybe: new Optional(new UuidValue(alias)),
            }),
            new Struct({
              id: new UuidValue(nil),
              maybe: new Optional(null, value.type),
            }),
          ),
        },
        transactionMode: 'snapshotReadOnly',
      });
      assert.equal(result.resultSets[0]?.rows[0]?.['id'], id);
      assert.equal(result.resultSets[0]?.rows[0]?.['literalMatches'], true);
      assert.equal(result.resultSets[0]?.rows[0]?.['empty'], null);
      assert.deepEqual(result.resultSets[1]?.rows[0]?.['ids'], [id, nil, last]);
      assert.equal(result.resultSets[2]?.rows[0]?.['maybe'], alias);
      assert.equal(result.resultSets[2]?.rows[1]?.['maybe'], null);
    },
  );

  await context.test(
    'server UUID order and keyset seek agree, independently of JS string order',
    async () => {
      const crafted = [
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000100',
        '00000000-0000-0000-0000-000000010000',
        '00000000-0000-0001-0000-000000000000',
        '00000000-0001-0000-0000-000000000000',
        '00000001-0000-0000-0000-000000000000',
        '00000100-0000-0000-0000-000000000000',
        '01000000-0000-0000-0000-000000000000',
      ];
      await db.orm.UuidItem.createAndCount(
        crafted.map((value) => ({
          tenant: 7,
          id: value,
          alias: value,
          optional: null,
          label: 'order',
        })),
      );
      const ordered = (
        await db.orm.UuidItem.where({ tenant: 7 })
          .select('id')
          .orderBy((row) => row.id.asc())
          .all()
      ).map((row) => row.id);
      assert.notDeepEqual(ordered, [...crafted].sort());
      for (const pivot of [2, 5]) {
        const cursor = ordered[pivot]!;
        const greater = (
          await db.orm.UuidItem.where((row) =>
            and(row.tenant.eq(7), row.id.gt(cursor)),
          )
            .select('id')
            .orderBy((row) => row.id.asc())
            .all()
        ).map((row) => row.id);
        const lower = (
          await db.orm.UuidItem.where((row) =>
            and(row.tenant.eq(7), row.id.lt(cursor)),
          )
            .select('id')
            .orderBy((row) => row.id.asc())
            .all()
        ).map((row) => row.id);
        assert.deepEqual(greater, ordered.slice(pivot + 1));
        assert.deepEqual(lower, ordered.slice(0, pivot));
      }
      const schema = await introspectYdb(native.core);
      assert.equal(
        schema.tables[table('UuidItem')]?.columns['id']?.nativeType,
        'Uuid',
      );
      const document = ydbControlTarget.inferPslContract(schema);
      const fields = document.namespaces
        .flatMap((namespace) => namespace.models)
        .flatMap((model) => model.fields);
      assert.ok(
        fields.some(
          (field) => field.name === 'id' && field.typeName === 'Uuid',
        ),
      );
      assert.ok(
        fields.some(
          (field) =>
            field.name === 'optional' &&
            field.typeName === 'Uuid' &&
            field.optional,
        ),
      );
    },
  );
});
