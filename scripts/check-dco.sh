#!/usr/bin/env bash
# Fails if any non-merge commit in <base>..<head> lacks a Signed-off-by line for its author's
# email (Developer Certificate of Origin, see CONTRIBUTING.md).
#
#   scripts/check-dco.sh origin/main HEAD
#
# DCO_EXEMPT_AUTHOR_EMAIL: commits by this author email are skipped. CI sets it only for PRs
# the Shira GitHub App opened: an agent can't certify the DCO; the human who merges does.
set -euo pipefail

base=${1:?usage: check-dco.sh <base> <head>}
head=${2:?usage: check-dco.sh <base> <head>}
exempt=${DCO_EXEMPT_AUTHOR_EMAIL:-}

missing=0
for sha in $(git rev-list --no-merges "$base..$head"); do
  email=$(git log -1 --format=%ae "$sha")
  if [[ -n "$exempt" && "$email" == "$exempt" ]]; then
    echo "skip   $(git log -1 --format='%h %s' "$sha") (agent commit)"
    continue
  fi
  # Trailers only, so a quoted "Signed-off-by:" in the body doesn't count.
  if git log -1 --format='%(trailers:key=Signed-off-by,valueonly)' "$sha" | grep -qiF "<$email>"; then
    echo "ok     $(git log -1 --format='%h %s' "$sha")"
  else
    echo "MISSING $(git log -1 --format='%h %s' "$sha") (no Signed-off-by for <$email>)"
    missing=$((missing + 1))
  fi
done

if ((missing > 0)); then
  cat >&2 <<EOF

$missing commit(s) lack a sign-off. Sign them off and force-push:
  git rebase --signoff $base && git push --force-with-lease
See CONTRIBUTING.md.
EOF
  exit 1
fi
