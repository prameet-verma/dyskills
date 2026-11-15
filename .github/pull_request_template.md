## What and why

<!-- What changes, and which PRD section or issue it serves. -->

## Checklist

- [ ] Tests were written first and cover the change
- [ ] `pnpm check` and `pnpm build` pass
- [ ] Exported symbols have TSDoc stating purpose and contract
- [ ] Package READMEs are updated if an API changed
- [ ] `CHANGELOG.md` is updated under `[Unreleased]`
- [ ] An ADR is added or updated for a design decision
- [ ] `CONTRACT_VERSION` is bumped and `pnpm gen:schemas` is run for a breaking contract change
