# Contributing to Shira

Thanks for helping. Shira is licensed under [Apache-2.0](LICENSE).

## Sign your commits (DCO)

Every commit must carry a `Signed-off-by` line certifying the
[Developer Certificate of Origin](https://developercertificate.org/): that you wrote the
change or otherwise have the right to submit it under the project's license.

```sh
git commit -s -m "Fix lease renewal race"
```

This adds `Signed-off-by: Your Name <you@example.com>` using your git config.

## Before opening a pull request

```sh
pnpm typecheck
pnpm test
pnpm validate-config
```

Changes to anything in `src/contracts/` change the wire format between agents. Explain the
change in the PR, regenerate `schemas/` with `pnpm schemas`, and update `docs/contracts.md`
if the handoff or resume flow changes.
