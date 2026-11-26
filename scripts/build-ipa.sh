#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
icon=${T3MOBILE_ICON_PATH:-}
if (( $# )); then
  if [[ $# != 2 || $1 != --icon || -z $2 ]]; then
    echo "Usage: build-ipa.sh [--icon <1024x1024.png>]" >&2
    exit 2
  fi
  icon=$2
fi
if [[ -n $icon ]]; then
  [[ -f $icon ]] || { echo 'Icon file does not exist' >&2; exit 2; }
  icon="$(cd "$(dirname "$icon")" && pwd)/$(basename "$icon")"
  properties=$(sips -g format -g pixelWidth -g pixelHeight "$icon")
  for prop in 'format: png' 'pixelWidth: 1024' 'pixelHeight: 1024'; do
    grep -Fxq "  $prop" <<< "$properties" || { echo 'Expected a 1024x1024 PNG icon' >&2; exit 2; }
  done
fi
cd "$root"
staging="$(mktemp -d "${TMPDIR:-/tmp}/t3mobile-ipa.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
mkdir -p "$staging/ios/Core" build
cp ios/project.yml "$staging/ios/"
cp -R ios/Core/{Package.swift,Sources,Tests} "$staging/ios/Core/"
ditto ios/T3Mobile "$staging/ios/T3Mobile"
if [[ -n $icon ]]; then
  cp "$icon" "$staging/ios/T3Mobile/Assets.xcassets/AppIcon.appiconset/Link.png"
fi
xcodegen generate --spec "$staging/ios/project.yml"
xcodebuild build -project "$staging/ios/T3Mobile.xcodeproj" -scheme T3Mobile -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath "$staging/derived" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO
app="$staging/derived/Build/Products/Release-iphoneos/T3Mobile.app"
[[ -x "$app/T3Mobile" && -s "$app/Assets.car" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")" == app.t3mobile.client ]]
mkdir "$staging/Payload"
ditto "$app" "$staging/Payload/T3Mobile.app"
(cd "$staging" && /usr/bin/zip -qr unsigned.ipa Payload)
unzip -tq "$staging/unsigned.ipa"
mv "$staging/unsigned.ipa" build/T3Mobile-unsigned.ipa
(cd build && shasum -a 256 T3Mobile-unsigned.ipa | tee T3Mobile-unsigned.ipa.sha256)
