#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
xcodegen generate --spec ios/project.yml
xcodebuild build -project ios/T3Mobile.xcodeproj -scheme T3Mobile -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath build/ios-device \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO
app=build/ios-device/Build/Products/Release-iphoneos/T3Mobile.app
[[ -x "$app/T3Mobile" && -s "$app/Assets.car" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")" == app.t3mobile.client ]]
staging="$(mktemp -d "${TMPDIR:-/tmp}/t3mobile-ipa.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
mkdir "$staging/Payload"
ditto "$app" "$staging/Payload/T3Mobile.app"
(cd "$staging" && /usr/bin/zip -qr unsigned.ipa Payload)
unzip -tq "$staging/unsigned.ipa"
mv "$staging/unsigned.ipa" build/T3Mobile-unsigned.ipa
(cd build && shasum -a 256 T3Mobile-unsigned.ipa | tee T3Mobile-unsigned.ipa.sha256)
