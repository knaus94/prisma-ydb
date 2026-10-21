# Architecture

One publishable package owns the integration. Nx and Yarn are development tools,
not runtime dependencies. The basic example is a private consumer workspace.

| Module               | Responsibility                                                     |
| -------------------- | ------------------------------------------------------------------ |
| `src/driver`         | SDK sessions, pool, cancellation, retries, values and transactions |
| `src/runtime`        | Prisma runtime, YQL compiler, codecs and ORM factory               |
| `src/control`        | Authoring, introspection, migration planning and journaling        |
| `src/environment.ts` | Official SDK authentication/TLS environment provider               |

Runtime entry points do not import the CLI runner. Shared contract helpers are
used by runtime and control. Consumers use named subpaths; internal files are not
exported. TypeScript emits ESM and declarations without bundling another copy of
Prisma or the SDK.

Prisma versions are pinned because the target uses RC interfaces. Upgrades require
checking AST, codecs, runtime lifecycle, generated imports and migration contracts
together. Scoped codec-validation optimization depends on the pinned runtime.

The original application repository remains independent. Review later upstream
changes against `ORIGIN.md` rather than overwriting extracted sources blindly.
The package targets Prisma 8's SQL-family API.
