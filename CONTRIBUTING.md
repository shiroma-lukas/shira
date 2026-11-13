# Contributing to Shira

Thanks for helping. Shira is licensed under [Apache-2.0](LICENSE).

## Sign your commits (DCO)

Every commit must carry a `Signed-off-by` line certifying the
[Developer Certificate of Origin](https://developercertificate.org/): that you wrote the
change or otherwise have the right to submit it under the project's license.

```sh
git commit -s -m "Fix lease renewal race"
```

This adds `Signed-off-by: Your Name <you@example.com>` using your git config. The sign-off's
email must match the commit's author email. CI (`dco`) checks every commit in a pull request; to
fix a branch, sign off its commits and force-push:

```sh
git rebase --signoff origin/main && git push --force-with-lease
```

You can run the same check locally with `scripts/check-dco.sh origin/main HEAD`.

Commits Shira's agents make in pull requests the Shira GitHub App opens are exempt: an agent
can't certify the DCO. The person who reviews and merges such a pull request takes on that
certification.

## Before opening a pull request

```sh
pnpm typecheck
pnpm test
pnpm validate-config
```

Changes to anything in `src/contracts/` change the wire format between agents. Explain the
change in the PR, regenerate `schemas/` with `pnpm schemas`, and update `docs/contracts.md`
if the handoff or resume flow changes. CI fails if `schemas/` doesn't match the contracts.

Pull requests into `main` must be up to date with it before merging (CI then tests exactly what
lands), and every review conversation must be resolved.
