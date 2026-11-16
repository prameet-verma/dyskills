# Releasing

The CLI is published as the unscoped npm package `dynamic-skills`. Publishing is a human step.

## Versioning policy

The public API is:

- command names, flags, stdout fields, exit codes and error codes;
- `CONTRACT_VERSION` and the documents in `schemas/`;
- the files `dynamic-skills init` writes.

Before 1.0 (`0.y.z`), a breaking change bumps `y`; everything else bumps `z`. From 1.0, standard
semver applies: a breaking change bumps the major version; new commands, flags or optional fields
bump the minor version; fixes bump the patch version. A `CONTRACT_VERSION` bump is always breaking.

## Checklist

1. Choose a license, then add `LICENSE` and the `"license"` field to `packages/cli/package.json`.
   The release check fails until both exist.
2. Claim the npm name `dynamic-skills`.
3. Configure the `npm` GitHub environment (required reviewers) and the `NPM_TOKEN` secret, or npm
   trusted publishing.
4. Bump the version in `packages/cli/package.json` and update `CHANGELOG.md`.
5. Run `pnpm --filter dynamic-skills publish --dry-run --no-git-checks` locally.
6. Run `pnpm exec tsx scripts/check-release.ts --tag v<version>`; it must print no problems.
7. Tag `v<version>` and push the tag.
8. Approve the `Release` job. It runs the checks, then publishes with `--provenance`.

To rehearse without publishing, run the `Release` workflow manually (`workflow_dispatch`); its
`dry-run` input defaults to true.

Always pack and publish through pnpm (`pnpm pack`, `pnpm publish`): it applies `publishConfig` and
rewrites `workspace:` ranges. The workspace packages are bundled into `dist/` by tsup, so they are
`devDependencies` of the CLI and the published `dependencies` resolve from npm.
