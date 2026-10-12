#!/usr/bin/env bash
# Run by .github/workflows/release.yml (early, and again right before publishing):
#   scripts/release-tag-guard.sh v<version> <commit-sha>
# Never re-publish under an old tag. When the tag already exists on origin it must point at <commit-sha>
# (a re-run of the same push): exit 0. Any other commit means package.json was not bumped: exit 1, because the
# publish step would otherwise overwrite that release's assets and notes while its tag still names the old code.
set -euo pipefail
tag="${1:?usage: release-tag-guard.sh v<version> <commit-sha>}"
want="${2:?usage: release-tag-guard.sh v<version> <commit-sha>}"
refs="$(git ls-remote --tags origin "refs/tags/${tag}" "refs/tags/${tag}^{}")" || { echo "::error::could not list the tags of origin"; exit 1; }
if [ -z "$refs" ]; then echo "${tag} is new"; exit 0; fi
# an annotated tag lists the tag object and, as ^{}, the commit it names; a lightweight tag only the commit
sha="$(printf '%s\n' "$refs" | awk -v r="refs/tags/${tag}^{}" '$2 == r { print $1 }')"
[ -n "$sha" ] || sha="$(printf '%s\n' "$refs" | awk -v r="refs/tags/${tag}" '$2 == r { print $1 }')"
if [ "$sha" != "$want" ]; then
  echo "::error::${tag} is already released from ${sha}, not this commit (${want}): bump the version in package.json"
  exit 1
fi
echo "${tag} already points at this commit: a re-run, publishing again is safe"
