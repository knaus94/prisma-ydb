# Releasing

Prepared package: `prisma-ydb@0.1.0-rc.0`. Nothing has been published by this task.
Registry name availability does not establish ownership; verify publishing rights
before first release. A different name also requires updating generated imports
in `runtime/descriptors.ts`, `control/config.ts` and `control/planner.ts`.

```bash
yarn install --immutable
yarn release:version 0.1.0-rc.1
# Update CHANGELOG.md and review version/lockfile changes.
yarn check
yarn package:pack
yarn release:dry-run
npm login
yarn release:publish
```

Versioning creates no commits/tags. Prereleases publish to `next`, stable versions
to `latest`. Prepack builds the library; prepublish runs offline checks. Root
release commands also validate the consumer. Dry run executes publication hooks
without uploading. Inspect the tarball and install it in a clean consumer.

Published files are allowlisted: compiled JavaScript, TypeScript declarations and
declaration maps, README, license and package metadata. Sources, documentation
guides, `.env`, databases, application migrations and Nx caches are excluded.
Consumers do not need Nx or Yarn at runtime.

## GitHub

`check.yml` checks and packs on push/pull request. `publish.yml` runs by manual
dispatch from the default branch, using the `npm` environment and trusted npm
publishing. Set the actual public repository URL in package `repository` metadata,
then configure npm's trusted publisher for that repository, workflow `publish.yml`
and environment `npm`. Initial package creation uses an authorized local login.

The workflow uses `id-token: write` and provenance; no registry token is committed.
Configure the GitHub environment's release rules before enabling publication.
This local project has no fabricated repository URL or remote. Account-specific
hosted publishing configuration remains necessary.

References: [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/),
[lifecycle hooks](https://docs.npmjs.com/cli/v11/using-npm/scripts/),
[trusted publishing](https://docs.npmjs.com/trusted-publishers/).
