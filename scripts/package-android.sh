#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
tools="$sdk/build-tools/${ANDROID_BUILD_TOOLS:-36.1.0}"
platform="$sdk/platforms/android-36/android.jar"
if [[ -z "${JAVA_HOME:-}" && -d '/Applications/Android Studio.app/Contents/jbr/Contents/Home' ]]; then
  export JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home'
fi
if [[ -n "${JAVA_HOME:-}" ]]; then export PATH="$JAVA_HOME/bin:$PATH"; fi
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p dist "$work/classes" "$work/dex"

"$tools/aapt2" compile --dir android/res -o "$work/resources.zip"
"$tools/aapt2" link -I "$platform" --manifest android/AndroidManifest.xml \
  --java "$work/generated" -o "$work/base.apk" "$work/resources.zip"
javac --release 8 -classpath "$platform" -d "$work/classes" \
  "$work/generated/app/tongxi/chat/R.java" android/src/*.java
jar cf "$work/classes.jar" -C "$work/classes" .
"$tools/d8" --lib "$platform" --min-api 26 --output "$work/dex" "$work/classes.jar"
(cd "$work/dex" && zip -q -0 "$work/base.apk" classes.dex)
"$tools/zipalign" -p -f 4 "$work/base.apk" "$work/aligned.apk"

keystore="${TONGXI_ANDROID_KEYSTORE:-$HOME/.android/debug.keystore}"
if [[ -z "${TONGXI_ANDROID_KEYSTORE:-}" && ! -f "$keystore" ]]; then
  mkdir -p "$(dirname "$keystore")"
  keytool -genkeypair -keystore "$keystore" -storepass android -keypass android \
    -alias androiddebugkey -dname 'CN=Android Debug,O=Android,C=US' -keyalg RSA -keysize 2048 -validity 10000
fi
"$tools/apksigner" sign --ks "$keystore" \
  --ks-key-alias "${TONGXI_ANDROID_KEY_ALIAS:-androiddebugkey}" \
  --ks-pass "${TONGXI_ANDROID_KEYSTORE_PASSWORD:-pass:android}" \
  --out "$work/Tongxi-android.apk" "$work/aligned.apk"
"$tools/apksigner" verify --verbose "$work/Tongxi-android.apk"
mv "$work/Tongxi-android.apk" dist/Tongxi-android.apk
