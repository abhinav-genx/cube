#!/bin/bash
# Checks a RELEASE build of Cube on an Android emulator/phone: manifest, accessibility exposure of
# the keypad, and a random-input (monkey) crash test. WARNING: clears Cube's data.
#   bash tests/e2e/android-release-check.sh path/to/app-release.apk
set -u
APK="${1:?apk path}"
PKG=app.cube.vault
S="${ANDROID_SERIAL:-emulator-5554}"
A="adb -s $S"
fail=0
check() { if eval "$2"; then echo "PASS  $1"; else echo "FAIL  $1"; fail=1; fi; }

AAPT=$(ls "$ANDROID_HOME"/build-tools/*/aapt 2>/dev/null | tail -1)
PERMS=$("$AAPT" dump permissions "$APK")
echo "$PERMS" | sed 's/^/      /'
check "no INTERNET permission"             '! grep -q "android.permission.INTERNET" <<<"$PERMS"'
check "no camera/microphone/storage/overlay" '! grep -qE "CAMERA|RECORD_AUDIO|WRITE_EXTERNAL|SYSTEM_ALERT_WINDOW|READ_MEDIA_VIDEO" <<<"$PERMS"'
BADGING=$("$AAPT" dump badging "$APK")
check "not debuggable"                     '! grep -q "application-debuggable" <<<"$BADGING"'
XML=$("$AAPT" dump xmltree "$APK" AndroidManifest.xml)
check "allowBackup=false"                  'grep -A0 "allowBackup" <<<"$XML" | grep -q "0x0"'
# Exported components with no permission guard (androidx's ProfileInstallReceiver is exported but
# needs android.permission.DUMP, which only the system and adb hold).
UNGUARDED=$(python3 -c '
import re, sys
xml = sys.stdin.read()
out = []
for block in re.split(r"\n\s*E: (?=activity|service|receiver|provider)", xml)[1:]:
    head = block.split("\n      E: ")[0]
    if "android:exported(0x01010010)=(type 0x12)0xffffffff" in head and "android:permission(" not in head:
        out.append(re.search(r"android:name\(0x01010003\)=\"([^\"]+)", head).group(1))
print(" ".join(out))' <<<"$XML")
echo "      exported without a permission: $UNGUARDED"
check "only the launcher activity is exported without a permission" '[ "$UNGUARDED" = "app.cube.vault.MainActivity" ]'

$A uninstall $PKG >/dev/null 2>&1
$A install -r "$APK" >/dev/null && echo "      installed"
$A shell am start -W -n $PKG/.MainActivity >/dev/null; sleep 6
$A shell uiautomator dump /sdcard/rel.xml >/dev/null 2>&1
UI=$($A shell cat /sdcard/rel.xml)
check "setup keypad exposes no digits to accessibility" '! grep -qE "(text|content-desc)=\"[0-9]\"" <<<"$UI"'
check "window is FLAG_SECURE"              '$A shell dumpsys window windows | grep -A40 "$PKG/$PKG.MainActivity" | grep -q " SECURE"'

$A logcat -c
echo "      monkey: 3000 random events on Cube only (no system keys)"
MONKEY=$($A shell monkey -p $PKG --pct-syskeys 0 --pct-appswitch 0 --throttle 60 -s 42 -v 3000 2>&1)
check "monkey finished without crash or ANR" '! grep -qE "CRASH|ANR in|Monkey aborted" <<<"$MONKEY" && grep -q "Monkey finished" <<<"$MONKEY"'
check "no FATAL EXCEPTION in the log"      '! $A logcat -d | grep -q "FATAL EXCEPTION"'
exit $fail
