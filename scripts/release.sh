#!/usr/bin/env bash
#
# Cut a GitHub release: build the artifacts, tag, push, upload.
#
#   npm run release                 # release the version in package.json
#   npm run release -- 0.2.0        # bump package.json to 0.2.0 first
#   npm run release -- --dry-run    # build + show what would happen, touch nothing remote
#
# Needs the gh CLI, authenticated (`gh auth status`). Pushing the tag is also
# enough on its own: .github/workflows/release.yml builds and uploads the same
# artifacts from CI.
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

DRY=0
BUMP=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) BUMP="$a" ;;
  esac
done

if [ -n "$BUMP" ]; then
  echo "==> bumping version to $BUMP"
  npm version "$BUMP" --no-git-tag-version >/dev/null
fi

VERSION=$(node -p "require('./package.json').version")
NAME=$(node -p "require('./package.json').name")
TAG="v$VERSION"

command -v gh >/dev/null || { echo "gh CLI not found: https://cli.github.com" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated: run 'gh auth login'" >&2; exit 1; }

if [ -n "$(git status --porcelain)" ]; then
  if [ "$DRY" = "1" ]; then
    echo "!! working tree is dirty (a real release would refuse)"
  else
    echo "working tree is dirty: commit or stash first" >&2
    git status --short >&2
    exit 1
  fi
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "tag $TAG already exists: bump the version (npm run release -- 0.1.1)" >&2
  exit 1
fi

bash scripts/package.sh

NOTES=$(mktemp)
{
  echo "## $NAME $TAG"
  echo
  PREV=$(git describe --tags --abbrev=0 2>/dev/null || true)
  if [ -n "$PREV" ]; then
    echo "### Changes since $PREV"
    git log --no-merges --pretty='- %s' "$PREV..HEAD"
  else
    echo "First release."
  fi
  echo
  echo "### Install"
  echo '```bash'
  echo "npm install -g $NAME-$VERSION.tgz        # needs the npm registry for js-tiktoken"
  echo "# or, no network, no npm install:"
  echo "tar xzf $NAME-$VERSION-standalone.tar.gz && cd $NAME-$VERSION"
  echo "node bin/th-dash.js --open               # live dashboard"
  echo '```'
  echo
  echo "Verify with \`shasum -a 256 -c SHA256SUMS.txt\`."
} > "$NOTES"

if [ "$DRY" = "1" ]; then
  echo
  echo "==> dry run: would tag $TAG, push it, and create the release with"
  ls release | sed 's/^/      /'
  echo "==> release notes"
  sed 's/^/      /' "$NOTES"
  rm -f "$NOTES"
  exit 0
fi

echo "==> tagging $TAG"
git tag -a "$TAG" -m "$NAME $TAG"
git push origin "$TAG"

echo "==> creating the GitHub release"
gh release create "$TAG" \
  release/"$NAME-$VERSION".tgz \
  release/"$NAME-$VERSION"-standalone.tar.gz \
  release/SHA256SUMS.txt \
  --title "$NAME $TAG" --notes-file "$NOTES"
rm -f "$NOTES"

echo "==> done: $(gh release view "$TAG" --json url --jq .url)"
