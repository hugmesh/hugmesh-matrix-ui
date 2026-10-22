#!/usr/bin/env bash
# release-version.test.sh — exercises scripts/release-version.sh against
# throwaway package.json / package-lock.json pairs. Pure bash + python3, no
# network, no npm install.
#
#   bash scripts/release-version.test.sh        (npm run test:release-version)
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
guard="$here/release-version.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

pass=0
failures=0

# make_repo <dir> <package.json version> <lock version> <lock packages[""] version>
make_repo() {
  local dir
  dir=$1
  mkdir -p "$dir"
  printf '{"name":"x","version":"%s","private":true}\n' "$2" >"$dir/package.json"
  printf '{"name":"x","version":"%s","lockfileVersion":3,"packages":{"":{"name":"x","version":"%s"}}}\n' \
    "$3" "$4" >"$dir/package-lock.json"
}

# expect_ok <name> <dir> <event> <ref> <expected output line>...
expect_ok() {
  local name dir event ref out line
  name=$1
  dir=$2
  event=$3
  ref=$4
  shift 4
  if ! out=$(REPO_ROOT="$dir" GITHUB_EVENT_NAME="$event" GITHUB_REF="$ref" GITHUB_OUTPUT='' \
    bash "$guard" 2>&1); then
    echo "FAIL $name: expected success, got: $out"
    failures=$((failures + 1))
    return 0
  fi
  for line in "$@"; do
    if ! printf '%s\n' "$out" | grep -a -x -F -- "$line" >/dev/null; then
      echo "FAIL $name: missing '$line' in output: $out"
      failures=$((failures + 1))
      return 0
    fi
  done
  echo "ok   $name"
  pass=$((pass + 1))
}

# expect_refused <name> <dir> <event> <ref> <expected stderr fragment>
expect_refused() {
  local name dir event ref want out
  name=$1
  dir=$2
  event=$3
  ref=$4
  want=$5
  if out=$(REPO_ROOT="$dir" GITHUB_EVENT_NAME="$event" GITHUB_REF="$ref" GITHUB_OUTPUT='' \
    bash "$guard" 2>&1); then
    echo "FAIL $name: expected a refusal, got success: $out"
    failures=$((failures + 1))
    return 0
  fi
  case "$out" in
    *"$want"*)
      echo "ok   $name"
      pass=$((pass + 1))
      ;;
    *)
      echo "FAIL $name: refused for the wrong reason (wanted '$want'): $out"
      failures=$((failures + 1))
      ;;
  esac
}

good="$work/good"
make_repo "$good" 0.2.0-beta.1 0.2.0-beta.1 0.2.0-beta.1

expect_ok "push to main is a main build" "$good" push refs/heads/main \
  version=0.2.0-beta.1 kind=main prerelease=true channel=beta
expect_ok "dispatch on main is a main build" "$good" workflow_dispatch refs/heads/main kind=main
expect_ok "matching v tag is a release" "$good" push refs/tags/v0.2.0-beta.1 \
  version=0.2.0-beta.1 kind=release prerelease=true channel=beta
expect_ok "dispatch on the matching tag re-runs the release" "$good" workflow_dispatch \
  refs/tags/v0.2.0-beta.1 kind=release

final="$work/final"
make_repo "$final" 0.2.0 0.2.0 0.2.0
expect_ok "a final version is not a prerelease and moves no channel" "$final" push \
  refs/tags/v0.2.0 kind=release prerelease=false channel=

expect_refused "tag that does not match package.json" "$good" push refs/tags/v0.2.0-beta.2 \
  "does not match package.json version"
expect_refused "tag without the v prefix" "$good" push refs/tags/0.2.0-beta.1 "publishes nothing"
expect_refused "feature branch" "$good" workflow_dispatch refs/heads/feature/x "publishes nothing"
expect_refused "pull request merge ref" "$good" pull_request refs/pull/7/merge \
  "refusing to publish from a pull_request run"
expect_refused "pull_request_target even on main" "$good" pull_request_target refs/heads/main \
  "refusing to publish from a pull_request_target run"

lock_top="$work/lock-top"
make_repo "$lock_top" 0.2.0-beta.1 0.1.0 0.2.0-beta.1
expect_refused "lock top-level version disagrees" "$lock_top" push refs/heads/main \
  "package-lock.json version '0.1.0'"

lock_root="$work/lock-root"
make_repo "$lock_root" 0.2.0-beta.1 0.2.0-beta.1 0.1.0
expect_refused "lock packages[\"\"] version disagrees" "$lock_root" push refs/heads/main \
  "packages[\"\"].version '0.1.0'"

snap="$work/snap"
make_repo "$snap" 0.2.0-SNAPSHOT 0.2.0-SNAPSHOT 0.2.0-SNAPSHOT
expect_refused "SNAPSHOT version" "$snap" push refs/heads/main "is a SNAPSHOT"

plus="$work/plus"
make_repo "$plus" 0.2.0-beta.1+build.5 0.2.0-beta.1+build.5 0.2.0-beta.1+build.5
expect_refused "build metadata (+) is not a valid image tag" "$plus" push refs/heads/main \
  "is not MAJOR.MINOR.PATCH[-pre]"

rc="$work/rc"
make_repo "$rc" 0.3.0-rc.1 0.3.0-rc.1 0.3.0-rc.1
expect_refused "a pre-release other than -beta.N" "$rc" push refs/heads/main "is not -beta.N"

beta0="$work/beta0"
make_repo "$beta0" 0.3.0-beta.0 0.3.0-beta.0 0.3.0-beta.0
expect_refused "beta numbering starts at 1" "$beta0" push refs/heads/main "is not -beta.N"

expect_refused "missing event" "$good" "" refs/heads/main "GITHUB_EVENT_NAME is not set"

# The real repo's own files must pass on main: this is what keeps package.json
# and package-lock.json from drifting apart in a commit.
expect_ok "this repo's package.json and lock agree" "$(cd "$here/.." && pwd)" push refs/heads/main kind=main

echo "release-version: $pass passed, $failures failed"
[ "$failures" -eq 0 ]
