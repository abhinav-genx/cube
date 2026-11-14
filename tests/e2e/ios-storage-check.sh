#!/bin/bash
# Inspects what Cube leaves on disk in the booted iOS simulator (run after using the app).
#   bash tests/e2e/ios-storage-check.sh [marker text that must not appear anywhere]
set -u
MARKER="${1:-CUBE-E2E-SECRET-7f3a91}"
DATA=$(xcrun simctl get_app_container booted app.cube.vault data) || exit 1
D="$DATA/Documents/d"
echo "== vault files (size path)"
( cd "$D" && find . -type f -exec stat -f "%z %N" {} + | sort -k2 )
echo "== backup exclusion on Documents/d"
xattr -p com.apple.metadata:com_apple_backup_excludeItem "$D" >/dev/null 2>&1 && echo "excluded: yes" || echo "excluded: NO"
echo "== index sizes match"
a=$(stat -f %z "$D/0/i.bin"); b=$(stat -f %z "$D/1/i.bin"); [ "$a" = "$b" ] && echo "yes ($a)" || echo "NO ($a vs $b)"
echo "== blob sizes per folder"
for v in 0 1; do echo "$v: $(cd "$D/$v" && find . -name '*.bin' ! -name i.bin -exec stat -f %z {} + | sort -n | tr '\n' ' ')"; done
echo "== marker anywhere in the app container"
grep -rl "$MARKER" "$DATA" 2>/dev/null && echo "FOUND (bad)" || echo "not found"
echo "== plaintext caches (should be empty)"
find "$DATA/Library/Caches" "$DATA/tmp" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.heic' -o -iname '*.txt' -o -iname '*.pdf' \) 2>/dev/null | grep -v -i 'expo-font\|ExponentAsset' || echo "none"
echo "== keychain items for the app"
KC="$HOME/Library/Developer/CoreSimulator/Devices/$(xcrun simctl list devices booted | grep -o '[0-9A-F-]\{36\}' | head -1)/data/Library/Keychains/keychain-2-debug.db"
[ -f "$KC" ] && sqlite3 "$KC" "select agrp, svce, pdmn from genp where agrp like '%cube%' or svce like 'app.cube%';" 2>/dev/null || echo "(keychain db not readable)"
