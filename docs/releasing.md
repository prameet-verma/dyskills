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

1. Fill in the `[maintainer contact]` placeholder in `SECURITY.md` with a real private reporting
   address before the first release. Do not publish with the placeholder.
1. Keep `LICENSE` (AGPL-3.0) at the repository root (pnpm includes it in the tarball) and the
   `"license": "AGPL-3.0-only"` field in `packages/cli/package.json`. The release check fails if
   the field is missing or the tarball lacks `LICENSE`. (Done.)
1. Keep the `repository` field in `packages/cli/package.json`
   (`https://github.com/prameet-verma/dyskills`); the release check fails without it. (Done.)
1. Claim the npm name `dynamic-skills`.
1. Configure the `npm` GitHub environment (required reviewers) and the `NPM_TOKEN` secret, or npm
   trusted publishing.
1. Bump the version in `packages/cli/package.json` and update `CHANGELOG.md`.
1. Run `pnpm --filter dynamic-skills publish --dry-run --no-git-checks` locally.
1. Run `pnpm exec tsx scripts/check-release.ts --tag v<version>`; it must print no problems.
1. Tag `v<version>` on a commit that is already on `main` and push the tag. The publish job
   fetches `origin/main` and fails unless the tag's commit is an ancestor of it.
1. Approve the `Release` job. It runs the checks, then publishes with `--provenance`.

To rehearse without publishing, run the `Release` workflow manually (`workflow_dispatch`). A manual
run only dry-runs: its job has no `npm` environment, no token and only `contents: read`, and runs
the release check without a tag. Only a pushed `v*.*.*` tag publishes.

Follow-up: pin the third-party actions to commit SHAs (they use major-version tags, like `ci.yml`).

Always pack and publish through pnpm (`pnpm pack`, `pnpm publish`): it applies `publishConfig` and
rewrites `workspace:` ranges. The workspace packages are bundled into `dist/` by tsup, so they are
`devDependencies` of the CLI and the published `dependencies` resolve from npm.
