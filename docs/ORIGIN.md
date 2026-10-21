# Extraction origin

Extracted from `testprismarc/libs/prisma-ydb` at commit
`7b41fad` on 2026-10-22. All driver, runtime and control-plane sources
were copied from that revision, including the session/connection refactor,
readiness shutdown fix and shared transaction backoff.

Extraction changes the generated import paths from `@org/prisma-ydb` to
`prisma-ydb`, clarifies the idempotent-request API comment, and applies repository formatting. Framework and SDK versions remain pinned. The source application
repository remains independent; this project is not a symlink or a worktree.

Original application-specific Nest services and migration history are not part
of the published package. The basic example has its own schema and migration.
