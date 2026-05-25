# Deployment And Phone Install Guide

This guide deploys the full Phone LevelG stack and installs the mobile apps on Android and iPhone release devices. It intentionally uses placeholder device identifiers and placeholder secret values. Never commit real APNs keys, Firebase service accounts, Google plist/json files, LiveKit secrets, or physical device IDs.

## What Runs Where

OpenShift runs:

- Go backend API
- Postgres
- Redis
- LiveKit
- externally managed Secrets for invite code, LiveKit, APNs, FCM, Google/Firebase, database, and webhook values

Phones run:

- Android release app built from `apps/mobile/android`
- iPhone release app built from `apps/mobile/ios`

OpenShift does not receive mobile binaries. Backend images are built in OpenShift from committed GitHub source.

## Prerequisites

Local tools:

```sh
npm install
oc whoami
xcodebuild -showsdks
xcrun devicectl list devices
adb devices -l
```

Provider accounts and files:

- Apple Developer Program team with Push Notifications enabled for explicit App ID `io.levelg.phone`
- APNs Auth Key downloaded once from Apple as `AuthKey_<KEY_ID>.p8`
- Firebase project with Android app package `io.levelg.phone`
- Firebase service account JSON authorized for FCM v1 sends
- `apps/mobile/android/app/google-services.json`
- `apps/mobile/ios/PhoneLevelG/GoogleService-Info.plist`
- Google OAuth client IDs for Android, iOS, and web/dev browser fallback

Ignored local files:

```text
local-secrets/
deploy/openshift/secrets.local.yaml
apps/mobile/android/app/google-services.json
apps/mobile/ios/PhoneLevelG/GoogleService-Info.plist
apps/mobile/.env.local
```

## Secret Setup

Use generated values for deployed secrets. Do not use `devkey:secret` for deployed LiveKit; LiveKit requires secrets of at least 32 characters.

Example local secret material:

```sh
mkdir -p local-secrets
cp ~/Downloads/AuthKey_EXAMPLE123.p8 local-secrets/AuthKey_EXAMPLE123.p8
git check-ignore -v local-secrets/AuthKey_EXAMPLE123.p8

LIVEKIT_API_KEY="$(openssl rand -hex 16)"
LIVEKIT_API_SECRET="$(openssl rand -base64 48)"
```

Create or update OpenShift Secret data with placeholders replaced locally:

```sh
oc create namespace phone-levelg --dry-run=client -o yaml | oc apply -f -

oc -n phone-levelg create secret generic postgres \
  --dry-run=client -o yaml | oc apply -f -

oc -n phone-levelg create secret generic phone-levelg-github-webhook \
  --dry-run=client -o yaml | oc apply -f -

oc -n phone-levelg create secret generic phone-levelg-livekit \
  --dry-run=client -o yaml | oc apply -f -

oc -n phone-levelg create secret generic phone-levelg-server \
  --dry-run=client -o yaml | oc apply -f -

oc -n phone-levelg set data secret/phone-levelg-livekit \
  LIVEKIT_KEYS="${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}"

oc -n phone-levelg set data secret/postgres \
  POSTGRES_DB=phone_levelg \
  POSTGRES_USER=replace-with-postgres-user \
  POSTGRES_PASSWORD=replace-with-postgres-password

oc -n phone-levelg set data secret/phone-levelg-github-webhook \
  WebHookSecretKey=replace-with-private-github-webhook-secret

oc -n phone-levelg set data secret/phone-levelg-server \
  SHARED_INVITE_CODE=replace-with-private-invite-code \
  LIVEKIT_API_KEY="${LIVEKIT_API_KEY}" \
  LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET}" \
  DATABASE_URL='postgres://replace-user:replace-password@postgres:5432/phone_levelg?sslmode=disable' \
  REDIS_ADDR=redis:6379 \
  APNS_TEAM_ID=replace-with-apple-team-id \
  APNS_KEY_ID=EXAMPLE123 \
  APNS_BUNDLE_ID=io.levelg.phone \
  APNS_ENDPOINT=https://api.sandbox.push.apple.com \
  FCM_PROJECT_ID=replace-with-firebase-project-id \
  --from-file=APNS_PRIVATE_KEY=local-secrets/AuthKey_EXAMPLE123.p8 \
  --from-file=FCM_SERVICE_ACCOUNT_JSON=local-secrets/firebase-service-account.json
```

Use `https://api.sandbox.push.apple.com` for Xcode-installed development builds. Use `https://api.push.apple.com` only for distribution/TestFlight/App Store builds.

## Deploy The Stack

Apply runtime manifests:

```sh
oc apply -f deploy/openshift/postgres.yaml
oc apply -f deploy/openshift/redis.yaml
oc apply -f deploy/openshift/server.yaml
oc apply -f deploy/openshift/livekit.yaml
```

Build backend from GitHub source. Commit and push code before starting a build:

```sh
git status --short
git push
oc -n phone-levelg start-build phone-levelg-server
oc -n phone-levelg wait --for=condition=Complete build/phone-levelg-server-EXAMPLE --timeout=240s
oc -n phone-levelg rollout restart deployment/phone-levelg-server
oc -n phone-levelg rollout status deployment/phone-levelg-server --timeout=120s
```

Restart LiveKit after changing `phone-levelg-livekit`:

```sh
oc -n phone-levelg rollout restart deployment/phone-levelg-livekit
oc -n phone-levelg rollout status deployment/phone-levelg-livekit --timeout=120s
```

Check health:

```sh
oc -n phone-levelg get deploy,statefulset,pods,svc,route
oc -n phone-levelg logs deployment/phone-levelg-server --tail=120
oc -n phone-levelg logs deployment/phone-levelg-livekit --tail=120
curl -sS https://phone-levelg-server-phone-levelg.apps.example.test/healthz
```

Expected backend log at startup:

```text
INFO starting private chat API port=4000
```

Unexpected logs to fix before phone testing:

```text
disable apns provider; missing config
skip apns message push; provider disabled
TooManyProviderTokenUpdates
secret is too short
```

## LiveKit Host Forwarding

LiveKit is exposed through a MetalLB LoadBalancer service and host forwarding for LAN/VPN clients.

Example:

```sh
LIVEKIT_LB_IP="$(oc -n phone-levelg get svc phone-levelg-livekit -o jsonpath='{.status.loadBalancer.ingress[0].ip}')"
HOST_IP=192.0.2.10 \
LIVEKIT_LB_IP="${LIVEKIT_LB_IP}" \
sudo -E ./deploy/openshift/livekit-host-forward.sh
```

The app should use a LiveKit URL reachable from the phones, for example:

```text
ws://192.0.2.10:7880
```

## Build And Install Android

Connect the Android phone or emulator and confirm it appears:

```sh
adb devices -l
```

Example output with a fake device id:

```text
List of devices attached
ANDROID-EXAMPLE-001 device product:example model:Pixel_Example transport_id:1
```

Build a release APK pointed at the OpenShift backend and reachable LiveKit host:

```sh
cd apps/mobile/android
EXPO_PUBLIC_API_URL=https://phone-levelg-server-phone-levelg.apps.example.test \
EXPO_PUBLIC_LIVEKIT_URL=ws://192.0.2.10:7880 \
./gradlew assembleRelease
```

Install on one Android device:

```sh
adb -s ANDROID-EXAMPLE-001 install -r app/build/outputs/apk/release/app-release.apk
```

Launch from the phone, sign in with Google, enter the server invite code, and allow notifications. After login, confirm token registration from the backend database without printing token values:

```sh
oc -n phone-levelg exec postgres-0 -- psql -U phone_levelg -d phone_levelg \
  -c "select platform, push_token_type, count(*) from devices group by platform, push_token_type order by 1,2;"
```

Expected Android row:

```text
android | fcm | 1
```

## Build And Install iPhone

Connect iPhones by USB and confirm Xcode sees them:

```sh
xcrun devicectl list devices
```

Example output with fake device ids:

```text
iPhone Example A (00000000-1111-2222-3333-444444444444)
iPhone Example B (AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE)
```

Install CocoaPods dependencies when needed:

```sh
cd apps/mobile/ios
pod install
cd ../../..
```

Build a release app for physical iPhones. The local Google plist supplies the reversed iOS client ID:

```sh
GOOGLE_REVERSED_CLIENT_ID="$(plutil -extract REVERSED_CLIENT_ID raw apps/mobile/ios/PhoneLevelG/GoogleService-Info.plist)"

EXPO_PUBLIC_API_URL=https://phone-levelg-server-phone-levelg.apps.example.test \
EXPO_PUBLIC_LIVEKIT_URL=ws://192.0.2.10:7880 \
GOOGLE_REVERSED_CLIENT_ID="${GOOGLE_REVERSED_CLIENT_ID}" \
xcodebuild \
  -allowProvisioningUpdates \
  -workspace apps/mobile/ios/PhoneLevelG.xcworkspace \
  -scheme PhoneLevelG \
  -configuration Release \
  -sdk iphoneos \
  -derivedDataPath apps/mobile/ios/DerivedData-device \
  ENABLE_USER_SCRIPT_SANDBOXING=NO \
  build
```

Install on each connected iPhone using placeholder identifiers:

```sh
APP_PATH="apps/mobile/ios/DerivedData-device/Build/Products/Release-iphoneos/PhoneLevelG.app"

xcrun devicectl device install app \
  --device 00000000-1111-2222-3333-444444444444 \
  "${APP_PATH}"

xcrun devicectl device install app \
  --device AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE \
  "${APP_PATH}"
```

Open the app, sign in with Google on each iPhone, enter the server invite code, and allow notifications/microphone/camera. After login, confirm iOS token registration without printing token values:

```sh
oc -n phone-levelg exec postgres-0 -- psql -U phone_levelg -d phone_levelg \
  -c "select platform, push_token_type, count(*) from devices group by platform, push_token_type order by 1,2;"
```

Expected iOS rows for two iPhones:

```text
ios | apns      | 2
ios | apns-voip | 2
```

## Validation Checklist

Backend and provider checks:

```sh
npm run test:server
npm run test:native-assets
oc -n phone-levelg logs deployment/phone-levelg-server --since=10m
```

Message push:

- Put recipient phone in background or lock it.
- Send a direct 1-1 message from another device.
- Confirm the recipient receives a native notification.
- Confirm backend logs do not show APNs/FCM provider errors.

iPhone call:

- Lock the recipient iPhone.
- Start a video call from another phone.
- Confirm iOS shows the CallKit incoming-call UI.
- Accept and confirm LiveKit media connects.

Android call:

- Lock or background the Android device.
- Start a video call from another phone.
- Confirm Android shows the full-screen incoming-call UI.
- Accept and confirm LiveKit media connects.

Direct-chat cleanup:

- Send messages and an image attachment in a direct chat.
- Delete the direct chat from one participant.
- Confirm both participants see the direct history cleared.
- Confirm the lobby history is unaffected.

## Security Rules

- Never commit `AuthKey_*.p8`.
- Never commit Firebase service account JSON.
- Never commit real phone device IDs.
- Never commit real `deploy/openshift/secrets.local.yaml`.
- Keep `local-secrets/` ignored.
- Use placeholder IDs in docs, for example `00000000-1111-2222-3333-444444444444`.
- Rotate LiveKit, APNs, Firebase, and invite-code secrets if they are printed in logs or committed by mistake.
