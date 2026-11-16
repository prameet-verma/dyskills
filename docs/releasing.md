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

1. Choose a license, then add `LICENSE` at the repository root (pnpm includes it in the tarball)
   and the `"license"` field to `packages/cli/package.json`. The release check fails until the
   field exists, and again if the tarball lacks `LICENSE`.
1. Set the `repository` field in `packages/cli/package.json` before the first publish; the release
   check fails without it.
1. Claim the npm name `dynamic-skills`.
1. Configure the `npm` GitHub environment (required reviewers) and the `NPM_TOKEN` secret, or npm
   trusted publishing.
1. Bump the version in `packages/cli/package.json` and update `CHANGELOG.md`.
1. Run `pnpm --filter dynamic-skills publish --dry-run --no-git-checks` locally.
1. Run `pnpm exec tsx scripts/check-release.ts --tag v<version>`; it must print no problems.
1. Tag `v<version>` and push the tag.
1. Approve the `Release` job. It runs the checks, then publishes with `--provenance`.

To rehearse without publishing, run the `Release` workflow manually (`workflow_dispatch`). A manual
run only dry-runs: its job has no `npm` environment, no token and only `contents: read`, and runs
the release check without a tag. Only a pushed `v*.*.*` tag publishes.

Follow-up: pin the third-party actions to commit SHAs (they use major-version tags, like `ci.yml`).

Always pack and publish through pnpm (`pnpm pack`, `pnpm publish`): it applies `publishConfig` and
rewrites `workspace:` ranges. The workspace packages are bundled into `dist/` by tsup, so they are
`devDependencies` of the CLI and the published `dependencies` resolve from npm.
