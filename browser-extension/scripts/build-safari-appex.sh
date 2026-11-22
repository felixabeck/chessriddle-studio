#!/usr/bin/env bash
# Builds the Safari web extension bundle that ships inside the macOS application.
# Needs macOS with a full Xcode, Node with the repository's dependencies installed, and a
# Developer ID identity that codesign can use without a dialog. Written for bash 3.2.
# usage: APPLE_SIGNING_IDENTITY=<identity> build-safari-appex.sh <output directory> <version>
set -euo pipefail

app_name="ChessRiddle Studio"
app_identifier="com.chessriddle.studio"
# Apple's packaging tool names the extension target after the application.
target="$app_name Extension"
extension_identifier="$app_identifier.Extension"

fail() {
  echo "error: $*" >&2
  exit 1
}

if [ "$(uname -s)" != Darwin ]; then
  echo "error: the Safari extension can only be built on macOS with Xcode" >&2
  exit 2
fi
if [ "$#" -ne 2 ] || [ -z "$1" ] || [ -z "$2" ]; then
  echo "usage: APPLE_SIGNING_IDENTITY=<identity> $0 <output directory> <version>" >&2
  exit 2
fi
output=$1
version=$2
[ -n "${APPLE_SIGNING_IDENTITY:-}" ] || fail "APPLE_SIGNING_IDENTITY does not name a signing identity"

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

node "$root/scripts/build.mjs" --out "$work/web"
web="$work/web/chrome"

# Xcode renamed the tool; the older name is the fallback.
packager=""
for name in safari-web-extension-packager safari-web-extension-converter; do
  if xcrun --find "$name" > /dev/null 2>&1; then
    packager=$name
    break
  fi
done
[ -n "$packager" ] || fail "this Xcode has neither safari-web-extension-packager nor safari-web-extension-converter"

xcrun "$packager" "$web" \
  --project-location "$work/project" \
  --app-name "$app_name" \
  --bundle-identifier "$app_identifier" \
  --macos-only --copy-resources --no-open --no-prompt --force < /dev/null

projects=$(find "$work/project" -maxdepth 3 -type d -name '*.xcodeproj')
if [ "$(printf '%s\n' "$projects" | grep -c .)" -ne 1 ]; then
  find "$work/project" -maxdepth 3 >&2
  fail "expected exactly one Xcode project from $packager"
fi
listing=$(xcodebuild -project "$projects" -list)
if [ "$(printf '%s\n' "$listing" | grep -c "^[[:space:]]*$target\$")" -lt 1 ]; then
  printf '%s\n' "$listing" >&2
  fail "the generated project has no target named '$target'"
fi

# Unsigned here: the bundle is signed below with the entitlements of this repository, so the
# result does not depend on the signing settings of the generated project.
xcodebuild -project "$projects" -target "$target" -configuration Release \
  SYMROOT="$work/build" OBJROOT="$work/intermediates" \
  ARCHS="arm64 x86_64" ONLY_ACTIVE_ARCH=NO \
  CODE_SIGNING_ALLOWED=NO \
  PRODUCT_BUNDLE_IDENTIFIER="$extension_identifier" \
  MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$version" \
  build

appex="$work/build/Release/$target.appex"
if [ ! -d "$appex" ]; then
  find "$work/build" -maxdepth 3 >&2
  fail "xcodebuild produced no '$target.appex'"
fi

codesign --force --options runtime --timestamp \
  --entitlements "$root/safari/extension.entitlements" \
  -s "$APPLE_SIGNING_IDENTITY" "$appex"
codesign --verify --strict --verbose=2 "$appex"

info="$appex/Contents/Info.plist"
read_info() {
  /usr/libexec/PlistBuddy -c "Print :$1" "$info"
}
expect() {
  [ "$2" = "$3" ] || fail "$1 is '$2', expected '$3'"
}
expect CFBundleIdentifier "$(read_info CFBundleIdentifier)" "$extension_identifier"
expect CFBundleShortVersionString "$(read_info CFBundleShortVersionString)" "$version"
expect NSExtensionPointIdentifier "$(read_info NSExtension:NSExtensionPointIdentifier)" com.apple.Safari.web-extension

architectures=$(lipo -archs "$appex/Contents/MacOS/$(read_info CFBundleExecutable)")
for architecture in arm64 x86_64; do
  case " $architectures " in
    *" $architecture "*) ;;
    *) fail "the extension's executable lacks $architecture (has: $architectures)" ;;
  esac
done

# The manifest, and the files its content-script and web-accessible entries name, at the
# manifest's relative paths: what Safari needs to show the button.
for file in manifest.json src/core.js src/content.js src/content.css icons/48.png; do
  cmp "$web/$file" "$appex/Contents/Resources/$file" ||
    fail "$file in the bundle is not the built extension's file"
done

mkdir -p "$output"
rm -rf "$output/$target.appex"
ditto "$appex" "$output/$target.appex"
codesign --verify --strict "$output/$target.appex"
echo "Built $output/$target.appex ($extension_identifier $version, $architectures)"
