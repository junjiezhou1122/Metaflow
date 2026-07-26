#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
APP=${METAFLOW_APP_DESTINATION:-"$HOME/Applications/Metaflow.app"}
SIGNING_IDENTITY=${METAFLOW_CODESIGN_IDENTITY:--}
STAGING="$ROOT/.build/Metaflow.staging.app"
CONTENTS="$STAGING/Contents"

swift build --package-path "$ROOT"
BIN_DIR=$(swift build --package-path "$ROOT" --show-bin-path)

rm -rf "$STAGING"
install -d "$CONTENTS/MacOS" "$CONTENTS/Resources"
install -m 755 "$BIN_DIR/metaflow-mac" "$CONTENTS/MacOS/metaflow-mac"
install -m 644 "$ROOT/Info.plist" "$CONTENTS/Info.plist"
if [ "$SIGNING_IDENTITY" = "-" ]; then
  codesign --force --deep --sign - \
    --identifier com.metaflow.mac.visible \
    --requirements '=designated => identifier "com.metaflow.mac.visible"' \
    "$STAGING"
else
  codesign --force --deep --sign "$SIGNING_IDENTITY" "$STAGING"
fi

codesign --verify --deep --strict "$STAGING"
codesign -d -r- "$STAGING" 2>&1 | grep -q 'identifier "com.metaflow.mac.visible"'
plutil -lint "$CONTENTS/Info.plist"
install -d "$(dirname "$APP")"
rm -rf "$APP"
mv "$STAGING" "$APP"
printf '%s\n' "$APP"

if [ "${1:-}" = "--open" ]; then
  open "$APP"
elif [ "$#" -gt 0 ]; then
  printf 'unknown argument: %s\n' "$1" >&2
  exit 64
fi
