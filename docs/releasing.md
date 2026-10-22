# Releasing

Published as `prisma-ydb` on npm; prereleases use the `next` dist-tag. Verify
publishing rights before a release. A different name also requires updating
generated imports in `runtime/descriptors.ts`, `control/config.ts` and
`control/planner.ts`.

```bash
yarn install --immutable
yarn release:version 0.1.0-rc.2
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
The repository is `github.com/knaus94/prisma-ydb`. Account-specific hosted
publishing configuration (npm trusted publisher, `npm` environment) remains necessary.

References: [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/),
[lifecycle hooks](https://docs.npmjs.com/cli/v11/using-npm/scripts/),
[trusted publishing](https://docs.npmjs.com/trusted-publishers/).
