#!/usr/bin/env bash
#
# Cut a GitHub release: build the artifacts, tag, push, upload.
#
#   npm run release                 # release the version in package.json
#   npm run release -- 0.2.0        # bump package.json to 0.2.0, commit, tag, release
#   npm run release -- --dry-run    # build + show what would happen, touch nothing remote
#   npm run release -- --notes-file NOTES.md    # hand-written release notes instead of the git log
#
# Needs the gh CLI, authenticated (`gh auth status`). Pushing the tag is also
# enough on its own: .github/workflows/release.yml builds and uploads the same
# artifacts from CI.
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

DRY=0
BUMP=""
NOTES_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --notes-file) NOTES_FILE="$2"; shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) BUMP="$1" ;;
  esac
  shift
done
[ -n "$NOTES_FILE" ] && [ ! -f "$NOTES_FILE" ] && { echo "no such notes file: $NOTES_FILE" >&2; exit 1; }

NAME=$(node -p "require('./package.json').name")

command -v gh >/dev/null || { echo "gh CLI not found: https://cli.github.com" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated: run 'gh auth login'" >&2; exit 1; }

# This check has to come BEFORE the bump. `npm version` edits package.json and
# package-lock.json, so checking afterwards always found the tree dirty and
# refused: every `npm run release -- <version>` aborted before it built anything.
if [ -n "$(git status --porcelain)" ]; then
  if [ "$DRY" = "1" ]; then
    echo "!! working tree is dirty (a real release would refuse)"
  else
    echo "working tree is dirty: commit or stash first" >&2
    git status --short >&2
    exit 1
  fi
fi

SAVE=""
restore_bump() {
  [ -n "$SAVE" ] || return 0
  cp "$SAVE/package.json" "$SAVE/package-lock.json" .
  rm -rf "$SAVE"
  SAVE=""
}
# also on failure: packaging can abort after the bump, and leaving a half-bumped
# package.json behind from a dry run would be worse than useless
trap restore_bump EXIT

if [ -n "$BUMP" ]; then
  echo "==> bumping version to $BUMP"
  # a dry run must leave the tree byte-identical, so keep the originals aside
  SAVE=$(mktemp -d)
  cp package.json package-lock.json "$SAVE/"
  npm version "$BUMP" --no-git-tag-version >/dev/null
  [ "$DRY" = "1" ] || { rm -rf "$SAVE"; SAVE=""; }
fi

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  restore_bump
  echo "tag $TAG already exists: bump the version (npm run release -- 0.1.1)" >&2
  exit 1
fi

bash scripts/package.sh

NOTES=$(mktemp)
if [ -n "$NOTES_FILE" ]; then
  cat "$NOTES_FILE" > "$NOTES"
else
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
  echo "node bin/mph-dash.js --open               # live dashboard"
  echo '```'
  echo
  echo "Verify with \`shasum -a 256 -c SHA256SUMS.txt\`."
} > "$NOTES"
fi

if [ "$DRY" = "1" ]; then
  echo
  echo "==> dry run: would commit the bump, tag $TAG, push both, and create the release with"
  ls release | sed 's/^/      /'
  echo "==> release notes"
  sed 's/^/      /' "$NOTES"
  rm -f "$NOTES"
  restore_bump
  exit 0
fi

if [ -n "$(git status --porcelain -- package.json package-lock.json)" ]; then
  echo "==> committing the version bump"
  git commit -q -m "v$VERSION" -- package.json package-lock.json
fi

echo "==> tagging $TAG"
git tag -a "$TAG" -m "$NAME $TAG"
# Push the branch as well as the tag. The tag alone would leave the branch
# without the bump, and release.yml checks the tag against the package.json of
# the commit it points at.
git push origin "$(git rev-parse --abbrev-ref HEAD)" "$TAG"

# Two steps on purpose. `gh release create` WITH attachments reliably fails here with
# HTTP 404 from uploads.github.com, and the half-created release then disappears.
# Creating it empty and uploading afterwards works.
echo "==> creating the GitHub release"
gh release create "$TAG" --title "$NAME $TAG" --notes-file "$NOTES" --verify-tag
rm -f "$NOTES"

echo "==> uploading the artifacts"
gh release upload "$TAG" \
  release/"$NAME-$VERSION".tgz \
  release/"$NAME-$VERSION"-standalone.tar.gz \
  release/SHA256SUMS.txt \
  --clobber

echo "==> done: $(gh release view "$TAG" --json url --jq .url)"
