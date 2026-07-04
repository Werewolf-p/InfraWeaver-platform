#!/usr/bin/env sh
# Vendor the InfraWeaver Connector plugin into the console's build context.
#
# Both image builds use apps/infraweaver-console as their ONLY context (the
# dispatch service runs buildctl with `--local context=.` from this directory),
# so ../infraweaver-wp-connector is unreachable at image-build time. The plugin
# is therefore vendored into vendor/wp-connector/ and committed; this script
# refreshes that copy from the source of truth and runs automatically as the
# npm `prebuild` step. Inside a container build the source dir is absent and
# the committed vendor copy is used as-is.
set -eu

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$HERE/../infraweaver-wp-connector"
DEST="$HERE/vendor/wp-connector/infraweaver-connector"

if [ ! -d "$SRC" ]; then
  if [ -d "$DEST" ]; then
    echo "sync-wp-connector: source absent (container build) — using committed vendor copy"
    exit 0
  fi
  echo "sync-wp-connector: neither $SRC nor $DEST exists — run this from a full repo checkout" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST/includes"
cp "$SRC/infraweaver-connector.php" "$DEST/"
cp "$SRC/README.md" "$DEST/" 2>/dev/null || true
cp "$SRC"/includes/*.php "$DEST/includes/"
echo "sync-wp-connector: vendored $(find "$DEST" -type f | wc -l | tr -d ' ') files from $SRC"
