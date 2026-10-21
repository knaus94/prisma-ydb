import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { ydb, Text } from 'prisma-ydb/runtime';
import { ydbBindingFromEnv } from 'prisma-ydb/environment';
import type { Contract } from './generated/contract.d.js';
import contractJson from './generated/contract.json' with { type: 'json' };
import { createSelections } from './selections.js';
import type { FullTaskDto } from './dto.js';

const db = ydb<Contract>({ contractJson, binding: ydbBindingFromEnv() });
const selections = createSelections(db.orm);
const projectId = randomUUID();
const taskId = randomUUID();

try {
  await db.connect();
  console.log('Readiness:', await db.health({ timeoutMs: 1000 }));
  const task: FullTaskDto | null = await db.transaction(
    async (tx) => {
      await tx.orm.Project.create({ id: projectId, name: 'Prisma + YDB' });
      await tx.orm.Task.create({
        id: taskId,
        title: 'Native transaction',
        createdAt: new Date(),
        projectId,
      });
      await tx.yql(
        'DECLARE $id AS Utf8; UPDATE `Task` SET done = TRUE WHERE id = $id',
        { id: new Text(taskId) },
      );
      return tx.orm.Task.with(selections.fullTask)
        .where({ id: taskId })
        .first();
    },
    { retry: true },
  );
  console.log('ORM + YQL in one transaction:', task);
  console.log(
    'Reusable selection:',
    await db.orm.Task.with(selections.task).where({ id: taskId }).all(),
  );
  console.log('Pool:', db.stats());
} finally {
  try {
    // Only rows created by this invocation are removed; child first, no database FK.
    await db.transaction(async (tx) => {
      await tx.orm.Task.where({ id: taskId }).delete();
      await tx.orm.Project.where({ id: projectId }).delete();
    });
  } finally {
    await db.close();
  }
}
