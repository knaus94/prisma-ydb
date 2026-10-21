import 'dotenv/config';
import { definePrismaConfig } from 'prisma/config';
import { defineYdbConfig } from 'prisma-ydb/config';
import { ydbBindingFromEnv } from 'prisma-ydb/environment';

export default definePrismaConfig({
  orm: defineYdbConfig({
    contract: './prisma/contract.prisma',
    relationMode: 'application',
    output: './src/generated',
    migrations: { dir: './prisma/migrations' },
    db: {
      connection: ydbBindingFromEnv(
        process.env['YDB_CONNECTION_STRING'] ?? 'grpc://localhost:2137/local',
      ),
    },
  }),
});
