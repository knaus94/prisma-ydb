import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, quote } from './helpers.ts';

test(
  'managed feeds preserve migration checkpoints and reject physical drift',
  { timeout: 90_000 },
  async (t) => {
    const fixture = await createFixture(t, {
      schema: (table) =>
        [
          '// use prisma-8',
          'model Managed {',
          '  userKey Uint64',
          '  id String',
          '  value Int',
          '  @@id([userKey, id])',
          '  @@map(' + JSON.stringify(table('Managed')) + ')',
          '  @@partitioning(bySize: true, byLoad: true, minPartitions: 16, uniformPartitions: 16)',
          '  @@changefeed("history", mode: NewImage, format: Json, retention: "P30D", partitions: 16, autoPartitioning: false, consumers: ["reader"])',
          '}',
        ].join('\n'),
    });
    const resultText = (result: { stdout: string; stderr: string }) =>
      result.stdout + result.stderr;
    const success = async (args: string[]) => {
      const result = await fixture.prisma(args);
      assert.equal(result.code, 0, resultText(result));
      return result;
    };
    await success([
      'migration',
      'plan',
      '--from',
      '@empty',
      '--name',
      'initial',
    ]);

    // Lose the acknowledgement after server DDL, before the runner marks its step applied.
    // The fault lives only in this temporary config; the migration package is unchanged.
    const once = join(fixture.cwd, 'interrupted-once');
    let config = await readFile(fixture.configPath, 'utf8');
    config = config
      .replace('export default definePrismaConfig({orm:', 'const orm = ')
      .replace(/\}\);\s*$/, ';');
    config +=
      '\nimport {existsSync,writeFileSync} from "node:fs";\n' +
      'const create=orm.driver.create;\n' +
      'export default definePrismaConfig({orm:{...orm,driver:{...orm.driver,async create(...args){' +
      'const driver=await create(...args);const execute=driver.executeDdl.bind(driver);' +
      'driver.executeDdl=async(sql)=>{await execute(sql);if(sql.includes("ADD CHANGEFEED")&&!existsSync(' +
      JSON.stringify(once) +
      ')){' +
      'writeFileSync(' +
      JSON.stringify(once) +
      ',"done");throw new Error("integration interruption after feed DDL");}};return driver;}}}});\n';
    await writeFile(fixture.configPath, config);
    const interrupted = await fixture.prisma(['db', 'migrate']);
    assert.notEqual(
      interrupted.code,
      0,
      'The post-DDL interruption must fail migration admission.',
    );
    const journal = await fixture.native.executeYql({
      text: 'SELECT state FROM `_prisma_ydb_migrations` WHERE state="started"u;',
      transactionMode: 'snapshotReadOnly',
    });
    assert.equal(
      journal.resultSets[0]?.rows.length,
      1,
      resultText(interrupted),
    );
    await success(['db', 'migrate']);
    await success(['db', 'verify']);

    const physical = quote(fixture.table('Managed'));
    const topic = quote(fixture.table('Managed') + '/history');
    const partitioning = (enabled: boolean) =>
      'ALTER TABLE ' +
      physical +
      ' SET (AUTO_PARTITIONING_BY_SIZE=ENABLED, AUTO_PARTITIONING_BY_LOAD=' +
      (enabled ? 'ENABLED' : 'DISABLED') +
      ', AUTO_PARTITIONING_MIN_PARTITIONS_COUNT=16)';
    await fixture.ddl(partitioning(false));
    let drift = await fixture.prisma(['db', 'verify']);
    assert.notEqual(drift.code, 0);
    assert.match(resultText(drift), /partitioning\/changefeed drift.*byLoad/s);
    await fixture.ddl(partitioning(true));
    await success(['db', 'verify']);

    await fixture.ddl(
      'ALTER TOPIC ' + topic + ' SET (RETENTION_PERIOD=Interval("P7D"))',
    );
    drift = await fixture.prisma(['db', 'verify']);
    assert.notEqual(drift.code, 0);
    assert.match(
      resultText(drift),
      /partitioning\/changefeed drift.*retentionSeconds/s,
    );
    await fixture.ddl(
      'ALTER TOPIC ' + topic + ' SET (RETENTION_PERIOD=Interval("P30D"))',
    );
    await success(['db', 'verify']);

    await fixture.ddl(
      'ALTER TOPIC ' + topic + ' ADD CONSUMER `unexpected-reader`',
    );
    drift = await fixture.prisma(['db', 'verify']);
    assert.notEqual(drift.code, 0);
    assert.match(
      resultText(drift),
      /partitioning\/changefeed drift.*unexpected-reader/s,
    );
    await fixture.ddl(
      'ALTER TOPIC ' + topic + ' DROP CONSUMER `unexpected-reader`',
    );
    await success(['db', 'verify']);

    // Lower retention and consumer removal lose evidence; tuning and additions do not.
    const schema = await readFile(fixture.schemaPath, 'utf8');
    await writeFile(
      fixture.schemaPath,
      schema
        .replace('byLoad: true', 'byLoad: false')
        .replace('"P30D"', '"P7D"')
        .replace('["reader"]', '["replacement-reader"]'),
    );
    await success(['contract', 'emit']);
    await success([
      'migration',
      'plan',
      '--from',
      fixture.contractJson.storage.storageHash,
      '--name',
      'settings',
    ]);
    const app = join(fixture.cwd, 'migrations', 'app');
    const edge = (await readdir(app)).find((name) =>
      name.endsWith('_settings'),
    );
    assert.ok(edge);
    const authored = JSON.parse(
      await readFile(join(app, edge, 'ops.json'), 'utf8'),
    );
    const operations = authored.operations ?? authored;
    const operation = (fragment: string) =>
      operations.find((item: { execute: { sql: string }[] }) =>
        item.execute[0]?.sql.includes(fragment),
      );
    assert.equal(
      operation('AUTO_PARTITIONING_BY_LOAD')?.operationClass,
      'additive',
    );
    assert.equal(operation('RETENTION_PERIOD')?.operationClass, 'destructive');
    assert.equal(operation('DROP CONSUMER')?.operationClass, 'destructive');
    assert.equal(operation('ADD CONSUMER')?.operationClass, 'additive');
    for (const item of operations)
      assert.notDeepEqual(
        item.meta.ydbBefore,
        item.meta.ydbAfter,
        'Each DDL must advance its exact persisted checkpoint.',
      );
  },
);
