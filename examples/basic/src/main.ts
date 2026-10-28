import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { ydb, Text } from 'prisma-ydb/runtime';
import { ydbBindingFromEnv } from 'prisma-ydb/environment';
import type { Contract } from './generated/contract.d.js';
import contractJson from './generated/contract.json' with { type: 'json' };
import { createSelections } from './selections.js';
import { taskHistory } from './generated/yql.js';
import type { FullTaskDto } from './dto.js';

const db = ydb<Contract>({ contractJson, binding: ydbBindingFromEnv() });
const selections = createSelections(db.orm);
const Status = db.enums.TaskStatus;
const projectId = randomUUID();
const taskId = randomUUID();
const auditId = randomUUID();

try {
  await db.connect();
  console.log('Readiness:', await db.health({ timeoutMs: 1000 }));
  const task: FullTaskDto | null = await db.transaction(
    async (tx) => {
      await tx.orm.Project.create({
        id: projectId,
        name: 'Prisma + YDB',
        budget: '1234.50',
        tags: ['prisma', 'ydb'],
        settings: {
          notifications: { email: true, digest: 'daily' },
          theme: 'dark',
        },
      });
      await tx.orm.Task.create({
        id: taskId,
        title: 'Native transaction',
        dueOn: '2026-12-01',
        projectId,
        status: tx.enums.TaskStatus.members.DOING,
      });
      const before = await tx.orm.Task.where({ id: taskId }).first();
      await tx.yql(
        'DECLARE $id AS Utf8; UPDATE `Task` SET done = TRUE WHERE id = $id',
        { id: new Text(taskId) },
      );
      await tx.orm.Task.where({ id: taskId }).update({
        status: tx.enums.TaskStatus.members.DONE,
      });
      const after = await tx.orm.Task.where({ id: taskId }).first();
      console.log('Automatic timestamps:', {
        createdBefore: before?.createdAt,
        createdAfter: after?.createdAt,
        updatedBefore: before?.updatedAt,
        updatedAfter: after?.updatedAt,
      });
      return tx.orm.Task.with(selections.fullTask)
        .where({ id: taskId })
        .first();
    },
    { retry: true },
  );
  console.log('ORM + YQL in one transaction:', task);
  console.log(
    'Reusable selection:',
    await db.orm.Task.with(selections.task)
      .where({ id: taskId, status: Status.members.DONE })
      .all(),
  );
  console.log('Known task status:', Status.has(task?.status));
  console.log('Typed task history:', await taskHistory(db, { projectId }));
  console.log(
    'Included task dates:',
    await db.orm.Project.where({ id: projectId })
      .select('id')
      .include('tasks', (tasks) => tasks.select('id', 'dueOn'))
      .first(),
  );
  console.log(
    'Project types:',
    await db.orm.Project.where({ id: projectId }).first(),
  );
  console.log(
    'JSON true:',
    await db.orm.Project.where({ id: projectId })
      .where((p) => p.settings.jsonBoolean('notifications.email'))
      .select('id')
      .all(),
  );
  console.log(
    'JSON string:',
    await db.orm.Project.where({ id: projectId })
      .where((p) => p.settings.jsonString('theme').eq('dark'))
      .select('id')
      .all(),
  );
  console.log(
    'List has:',
    await db.orm.Project.where({ id: projectId })
      .where((p, { fns }) => fns.has(p.tags, 'ydb').buildAst())
      .select('id')
      .all(),
  );
  console.log(
    'List hasSome:',
    await db.orm.Project.where({ id: projectId })
      .where((p, { fns }) => fns.hasSome(p.tags, ['ydb', 'other']).buildAst())
      .select('id')
      .all(),
  );
  await db.orm.AuditEvent.create({ id: auditId, action: 'example.run' });
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  console.log(
    'Unexpired audit events:',
    await db.orm.AuditEvent.where({ id: auditId })
      .where((e) => e.at.gte(cutoff))
      .all(),
  );
  console.log('Pool:', db.stats());
} finally {
  try {
    // Only this invocation's parent is deleted; the client applies Cascade.
    await db.transaction(async (tx) => {
      await tx.orm.Project.where({ id: projectId }).delete();
      await tx.orm.AuditEvent.where({ id: auditId }).delete();
    });
    console.log(
      'Tasks after parent cascade:',
      await db.orm.Task.where({ projectId }).select('id').all(),
    );
  } finally {
    await db.close();
  }
}
