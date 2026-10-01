#!/usr/bin/env bash
#
# Build the release artifacts into release/.
#
#   npm run package                 # typecheck + test + build + both tarballs
#   SKIP_TESTS=1 npm run package    # skip the test run (CI already ran it)
#
# Produces:
#   release/token-harness-<v>.tgz                  npm-installable package (deps from the registry)
#   release/token-harness-<v>-standalone.tar.gz    dist + bin + runtime deps, runs offline on plain node
#   release/SHA256SUMS.txt
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NAME=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
OUT=release
STAGE_ROOT=".package-stage"
STAGE="$STAGE_ROOT/$NAME-$VERSION"

echo "==> packaging $NAME@$VERSION"
rm -rf dist "$OUT" "$STAGE_ROOT"
mkdir -p "$OUT"

echo "==> typecheck"
npm run --silent typecheck

if [ "${SKIP_TESTS:-0}" != "1" ]; then
  echo "==> test"
  npm test
fi

echo "==> build"
npm run --silent build
test -f dist/dashboard/cli.js || { echo "build produced no dist/dashboard/cli.js" >&2; exit 1; }

echo "==> npm tarball"
npm pack --pack-destination "$OUT" >/dev/null
TGZ="$OUT/$NAME-$VERSION.tgz"
test -f "$TGZ" || { echo "npm pack produced no $TGZ" >&2; exit 1; }

echo "==> standalone tarball"
mkdir -p "$STAGE"
cp -R dist bin package.json "$STAGE/"
cp README.md "$STAGE/" 2>/dev/null || true
[ -f LICENSE ] && cp LICENSE "$STAGE/"
[ -d docs ] && cp -R docs "$STAGE/"

# Copy the production dependency tree that is actually installed here, so the
# tarball runs with no network and no npm install. Falls back gracefully: the
# tokenizer degrades to a heuristic if js-tiktoken is absent.
npm ls --omit=dev --parseable --all 2>/dev/null | tail -n +2 | while read -r dep; do
  rel="${dep#"$PWD/"}"
  [ "$rel" = "$dep" ] && continue          # outside the repo (linked): skip
  mkdir -p "$STAGE/$(dirname "$rel")"
  cp -R "$dep" "$STAGE/$(dirname "$rel")/"
done

# Smoke-test the staged copy the way a user would run it.
( cd "$STAGE" && node bin/th-dash.js --help >/dev/null && node bin/th-sidecar.js --help >/dev/null ) \
  || { echo "staged tarball failed its smoke test" >&2; exit 1; }

tar -czf "$OUT/$NAME-$VERSION-standalone.tar.gz" -C "$STAGE_ROOT" "$NAME-$VERSION"
rm -rf "$STAGE_ROOT"

( cd "$OUT" && shasum -a 256 ./*.tgz ./*.tar.gz > SHA256SUMS.txt )

echo
echo "==> artifacts"
ls -lh "$OUT" | tail -n +2 | awk '{printf "    %-48s %s\n", $9, $5}'
echo
echo "install from the npm tarball:   npm install -g $TGZ"
echo "or run the standalone:          tar xzf $OUT/$NAME-$VERSION-standalone.tar.gz && node $NAME-$VERSION/bin/th-dash.js"
