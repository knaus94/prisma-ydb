# Basic consumer

From the repository root:

```bash
cp examples/basic/.env.example examples/basic/.env
yarn db:up
yarn db:migrate
yarn db:verify
yarn example:run
```

Edit `prisma/contract.prisma`. Generated client files go to `src/generated`.
`selections.ts` defines shared queries/inferred types; `dto.ts` implements them.
`main.ts` combines ORM and YQL in one transaction, reuses a selection after commit
and deletes only rows created by the current run.

Yarn links the dependency via `workspace:*`. Outside this repository, install the
published package or tarball and keep the explicit Prisma platform dependencies
needed by generated type imports.
