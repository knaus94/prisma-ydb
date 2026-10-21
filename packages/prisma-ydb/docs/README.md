# Documentation

Start with [installation and configuration](../README.md). This package provides
native YDB queries, a Prisma ORM 8 target and schema migrations.

| Guide                                               | What it covers                                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [Relations and referential integrity](relations.md) | `@relation`, includes, parent checks, deletion policies and concurrency without database FKs |
| [Schema and migrations](migrations.md)              | Authoring `.prisma`, generating changes, snapshots, deployment, drift and recovery           |
| [Transactions and retries](transactions.md)         | Commit/rollback, callback replay, timeouts and unknown outcomes                              |
| [Native YQL and types](yql.md)                      | Typed parameters, result sets, streaming and data representations                            |
| [Shared selections and DTOs](selections.md)         | Fragments, inferred result types and DTO compatibility                                       |
| [NestJS integration](nestjs.md)                     | Singleton lifecycle, readiness and shutdown                                                  |
| [Configuration and operations](operations.md)       | Authentication, TLS, pool settings, limits, metrics and deployment                           |
| [API reference](api.md)                             | Public entry points, detailed behavior and supported boundaries                              |

The source workspace additionally contains a runnable `examples/basic` consumer,
local Docker configuration, and maintainer guides in `docs/architecture.md` and
`docs/releasing.md`. All guides in this directory ship in the npm package.

## Capability overview

| Capability                                 | Current behavior                                                 |
| ------------------------------------------ | ---------------------------------------------------------------- |
| ORM reads and mutations                    | Native YQL compilation with typed values                         |
| Relation includes and filters              | Query metadata; application-managed referential integrity        |
| Interactive transactions                   | Serializable read-write; explicit whole-callback retry           |
| Raw YQL                                    | Typed parameters, buffered result sets or low-level streaming    |
| Schema migrations                          | Official Prisma CLI with native YDB planner and recovery journal |
| Physical foreign keys / automatic cascades | Unavailable; implement the documented application protocol       |
| Savepoints / nested transactions           | Unsupported                                                      |
| DDL atomicity                              | Operations can be partially applied; journal-based recovery      |
| Release status                             | Pinned Prisma RC integration; qualify it for your workload       |
