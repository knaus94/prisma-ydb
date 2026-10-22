# YDB Architecture Skill

A project-independent, **English-language** agent skill for designing, implementing, reviewing, and optimizing YDB systems. It is not tied to any application, framework, or programming language.

## Contents

- `SKILL.md` — agent activation metadata, mandatory workflow, decision rules, and review blockers.
- `references/01-data-model-and-keys.md` — ROW/COLUMN, primary keys, hot ranges, schema and types.
- `references/02-access-paths-and-queries.md` — indexes, access paths, projections, keyset pagination, EXPLAIN.
- `references/03-transactions-and-correctness.md` — Serializable, retries, `UNDETERMINED`, idempotency.
- `references/04-streaming-analytics-lifecycle.md` — COLUMN analytics, CDC/Topics, TTL, S3, backups.
- `references/05-operations-performance.md` — SDK discovery, Kubernetes, metrics, SLOs, load testing.
- `references/06-review-checklist.md` — architecture checklist and acceptance criteria.
- `references/sources.md` — official YDB documentation links.
- `examples/design-patterns.md` — generic patterns with no application-specific dependencies.

## Installation

The distribution archive contains a single `ydb-architecture/` directory. Extract the **entire** directory into your agent's skill location:

```bash
mkdir -p .agents/skills
unzip ydb-architecture.zip -d .agents/skills/
```

Other agents may load skills from `~/.claude/skills`, `$HOME/.agents/skills`, or a client-specific directory. Follow your agent's documentation. Preserve the relative `references/` and `examples/` paths.

## Example requests

- “Design a YDB schema for 100,000 events/sec, queried by owner and time.”
- “Review this YDB DDL and our three hottest queries.”
- “Design a Serializable transaction and a safe retry protocol for UNDETERMINED commits.”
- “Choose PK order, column partition hash keys, and partition count for analytics.”
- “Compare two YDB schemas by hot-shard risk, index write amplification, and distributed commit cost.”

## Important

This skill describes design rules and includes illustrative YQL. It does **not** certify that every snippet works unchanged on every YDB release. Before production use, the agent must verify the target version, validate DDL/YQL, measure the intended workload, and test failure recovery.
