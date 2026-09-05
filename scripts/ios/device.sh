#!/usr/bin/env bash
# Build, install and launch Minimus on the connected iPhone from the terminal.
#
#   scripts/ios/device.sh build [Debug|Release]   # xcodebuild (two passes; see below)
#   scripts/ios/device.sh install [Debug|Release] # devicectl install
#   scripts/ios/device.sh launch                  # devicectl launch
#   scripts/ios/device.sh all [Debug|Release]     # build + install + launch
#   scripts/ios/device.sh qa-host <ip:port>       # enable the QA bridge over USB (Release builds)
#
# Two build passes on a clean derived-data dir are deliberate: CocoaPods copies
# the vendored RunAnywhere xcframework slice from a script phase that is not
# declared as producing the file, so pass one can die at Ld with "Build input
# file cannot be found: librac_commons.a" and pass two links against what pass
# one copied (docs/SDK-FINDINGS.md §8).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
IOS_DIR="$(cd "$HERE/../../apps/mobile/ios" && pwd)"
DEVICE="${MINIMUS_DEVICE:-93B0EBE7-97A1-5357-8831-9725F4C442CD}"
BUNDLE_ID="ai.minimus.app"
CONFIG="${2:-Debug}"
APP="$IOS_DIR/build/Build/Products/${CONFIG}-iphoneos/mobile.app"

build() {
  cd "$IOS_DIR"
  local args=(-workspace mobile.xcworkspace -scheme mobile -configuration "$CONFIG"
    -destination "id=$DEVICE" -derivedDataPath build -allowProvisioningUpdates
    ENABLE_USER_SCRIPT_SANDBOXING=NO build)
  if ! xcodebuild "${args[@]}" > build/xcodebuild.log 2>&1; then
    echo "pass 1 failed; retrying (xcframework staging race)"
    grep -nE "error:" build/xcodebuild.log | grep -v "stat:(NSString" | head -5 || true
    xcodebuild "${args[@]}" > build/xcodebuild.log 2>&1 || {
      grep -nE "error:|Undefined symbol|duplicate symbol|ld: " build/xcodebuild.log | grep -v "stat:(NSString" | head -30
      exit 1
    }
  fi
  echo "built $APP"
}

install() {
  xcrun devicectl device install app --device "$DEVICE" "$APP"
}

launch() {
  xcrun devicectl device process launch --device "$DEVICE" --terminate-existing "$BUNDLE_ID"
}

qa_host() {
  local tmp
  tmp="$(mktemp -d)"
  printf '%s' "$3" > "$tmp/qa-host.txt"
  xcrun devicectl device copy to --device "$DEVICE" --source "$tmp/qa-host.txt" \
    --destination "Documents/qa-host.txt" --domain-type appDataContainer --domain-identifier "$BUNDLE_ID"
  echo "qa-host.txt set to $3 (restart the app)"
}

case "${1:-all}" in
  build) build ;;
  install) install ;;
  launch) launch ;;
  all) build; install; launch ;;
  qa-host) qa_host "$@" ;;
  *) echo "usage: $0 build|install|launch|all [Debug|Release] | qa-host <ip:port>"; exit 1 ;;
esac
