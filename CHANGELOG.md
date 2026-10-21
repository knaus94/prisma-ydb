# Changelog

## 0.1.0-rc.1

- Exclude sources and documentation guides from the npm package while retaining compiled code, types and declaration maps.
- Link package documentation to GitHub from the published README.
- Validate package contents with npm packing.

## 0.1.0-rc.0

- Extract native YDB driver, Prisma SQL-family runtime and migration support.
- Preserve upstream session/connection refactor and shared transaction backoff.
- Readiness becomes false from the start of client shutdown.
- Add public entry points, a standalone consumer, docs and release commands.
