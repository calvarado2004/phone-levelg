# Phone LevelG

Phone LevelG is a private mobile messaging app for iOS and Android. The goal is a small, self-hosted communication system for a trusted home/VPN network: messages, emojis, and voice/video calls without depending on a public SaaS backend for core app traffic.

The project is intentionally scoped to the pieces the app currently needs:

- React Native / Expo mobile client for iOS and Android
- Go 1.26 backend API
- Postgres 18 for durable state
- Redis for live event fan-out
- LiveKit integration point for voice/video media
- OpenShift deployment using the internal image registry
- PVC-backed state using storage class `px-csi-db`

MongoDB is not deployed. The MVP does not need a document database, and keeping the state layer to Postgres plus Redis makes operations, backups, tests, and failure recovery simpler.

## Repository Layout

```text
.
├── apps
│   ├── mobile              # React Native / Expo app
│   │   ├── android         # Generated native Android project
│   │   ├── ios             # Generated native iOS project
│   │   ├── App.tsx         # Main mobile UI and client logic
│   │   └── README.md
│   └── server              # Go backend
│       ├── cmd/server      # API entrypoint
│       ├── Dockerfile      # Go 1.26 container build
│       └── README.md
├── deploy
│   └── openshift           # OpenShift manifests
├── docs
│   └── ARCHITECTURE.md     # Architecture notes
├── tests
│   ├── deploy              # Container/deploy asset checks
│   ├── mobile              # Native project asset checks
│   └── openshift           # Manifest validation
└── docker-compose.yml      # Local Postgres/Redis
```

## Architecture

```text
iOS / Android app
  |
  | HTTPS
  |   - login
  |   - message history
  |   - LiveKit token requests
  |
  | WebSocket
  |   - live chat events
  |   - call ring events
  v
Go backend on OpenShift
  |
  ├── Postgres 18
  |     - users
  |     - rooms
  |     - messages
  |
  ├── Redis
  |     - room pub/sub
  |     - live event fan-out across backend replicas
  |
  └── LiveKit token minting

LiveKit server
  |
  └── WebRTC media for voice/video calls
```

The backend does not carry audio or video media. It only issues LiveKit JWTs. Mobile clients use those tokens to connect directly to LiveKit for WebRTC media.

## Runtime Components

### Mobile App

The mobile app lives in `apps/mobile`.

It provides:

- invite-code login
- joined-member lobby backed by Postgres
- a private `Home` room
- real-time messages over WebSocket
- emoji quick actions
- call buttons for LiveKit-backed voice/video rooms
- native Android and iOS projects for IDE/device builds

Important environment variables:

```sh
EXPO_PUBLIC_API_URL=https://your-private-api-host
EXPO_PUBLIC_LIVEKIT_URL=wss://your-private-livekit-host
```

For local development, defaults are:

```text
EXPO_PUBLIC_API_URL=http://localhost:4000
EXPO_PUBLIC_LIVEKIT_URL=ws://localhost:7880
```

For physical devices, use an address reachable from the device over LAN or VPN. Do not use `localhost` unless the API is running on the device itself.

Debug physical-device builds should point at the private OpenShift API:

```sh
EXPO_PUBLIC_API_URL=https://phone-levelg-server-phone-levelg.apps.ocp-think.levelg.io
EXPO_PUBLIC_LIVEKIT_URL=ws://192.168.1.88:7880
```

Convenience scripts are available from `apps/mobile`:

```sh
npm run android:openshift -w apps/mobile
npm run ios:openshift -w apps/mobile
```

Emulator/simulator builds default to the laptop-local Docker Compose stack:

- Android emulator: `http://10.0.2.2:4000`
- iOS Simulator: `http://localhost:4000`

### Go Backend

The backend lives in `apps/server` and is built with Go 1.26.

Responsibilities:

- validate invite-code login
- create users
- persist messages in Postgres
- return room history
- accept WebSocket connections
- publish/subscribe room events through Redis
- mint LiveKit room tokens
- expose OpenShift health probes

Startup is dependency-aware: the backend retries Postgres migration and Redis ping instead of crashing immediately while stateful services are still starting.

### Postgres

Postgres is the durable system of record.

OpenShift configuration:

- image: `docker.io/library/postgres:18-alpine`
- PVC storage class: `px-csi-db`
- PVC mount path: `/var/lib/postgresql`
- `PGDATA`: `/var/lib/postgresql/data/pgdata`

`PGDATA` intentionally points to a subdirectory under the PVC mount. That avoids the container trying to change ownership/permissions on the PVC root during initialization.

### Redis

Redis is used for live coordination, not durable message storage.

OpenShift configuration:

- image: `docker.io/library/redis:7-alpine`
- PVC storage class: `px-csi-db`
- append-only persistence enabled

Redis lets multiple backend replicas broadcast events to all clients in the same room without requiring sticky sessions.

### LiveKit

LiveKit is included in `deploy/openshift/livekit.yaml`. It is exposed through a MetalLB `LoadBalancer` service inside the OpenShift/libvirt network and forwarded from the host IP for LAN/VPN clients.

Current network plan:

- `192.168.1.88:7880/TCP`: LiveKit signaling, used by the mobile app as `ws://192.168.1.88:7880`
- `192.168.1.88:7881/TCP`: WebRTC TCP fallback
- `192.168.1.88:50100-50120/UDP`: WebRTC media

The OpenShift service receives a MetalLB IP from the libvirt network. The host runs a small `socat` forwarder from `192.168.1.88` to that MetalLB IP; see `deploy/openshift/livekit-host-forward.sh`.

The app/backend integration point is already present: the backend issues LiveKit JWTs from `/calls/token`.

## Local Development

Install dependencies:

```sh
npm install
```

Run local state services:

```sh
docker compose up -d
```

Run the Go API:

```sh
npm run dev:server
```

Run the mobile app:

```sh
npm run dev:mobile
```

The browser preview is useful for basic layout checks, but the app is a native iOS/Android app. Native WebRTC/calling behavior must be validated through Android and iOS builds.

## Native Projects

Native projects are generated under:

```text
apps/mobile/android
apps/mobile/ios
```

Android Studio should open:

```text
apps/mobile/android
```

Xcode should open:

```text
apps/mobile/ios/PhoneLevelG.xcodeproj
```

The Android Gradle files support `NODE_BINARY` and default to `/opt/homebrew/bin/node` so Android Studio can build even when launched from the GUI with a limited shell path.

iOS builds require CocoaPods. If `pod` is not installed, install CocoaPods and then run:

```sh
cd apps/mobile/ios
pod install
```

## OpenShift Deployment

The OpenShift manifests live in `deploy/openshift`.

They create:

- namespace `phone-levelg`
- backend `ImageStream`
- backend binary `BuildConfig`
- backend `Deployment`, `Service`, and `Route`
- Postgres `StatefulSet`, `Service`, Secret, and PVC
- Redis `StatefulSet`, `Service`, and PVC
- LiveKit `Deployment`, `Service`, and `Route`

Deploy stateful services and backend manifests:

```sh
oc apply -f deploy/openshift/postgres.yaml
oc apply -f deploy/openshift/redis.yaml
oc apply -f deploy/openshift/server.yaml
oc apply -f deploy/openshift/livekit.yaml
```

Build the backend into the OpenShift internal registry:

```sh
oc start-build phone-levelg-server -n phone-levelg --from-dir=. --follow
```

The backend deployment pulls:

```text
image-registry.openshift-image-registry.svc:5000/phone-levelg/phone-levelg-server:latest
```

Check rollout:

```sh
oc get deploy,statefulset,pvc,route -n phone-levelg
oc get pods -n phone-levelg
```

Expected healthy state:

```text
deployment/phone-levelg-server   2/2 available
statefulset/postgres             1/1 ready
statefulset/redis                1/1 ready
postgres PVC                     Bound, px-csi-db
redis PVC                        Bound, px-csi-db
```

## API Surface

### `GET /healthz`

Checks backend dependencies and returns:

```json
{
  "ok": true
}
```

### `POST /login`

Creates a simple session identity after invite-code validation.

```json
{
  "displayName": "User",
  "inviteCode": "home"
}
```

### `GET /rooms/{roomID}/messages`

Returns the latest room messages in chronological order.

### `GET /members`

Returns recently joined members for the lobby/contact strip.

### `GET /ws`

WebSocket endpoint for room events.

Required query parameters:

```text
roomId
userId
displayName
```

### `POST /calls/token`

Returns a LiveKit JWT for the requested room.

The current mobile call path verifies signaling, LiveKit token minting, room join, and microphone/camera permissions. A full in-call video grid and remote participant surface is still a separate UI task.

## Testing Strategy

Tests are part of the baseline, not a later cleanup task.

Run the core verification suite:

```sh
npm run test
```

Individual checks:

```sh
npm run typecheck
npm run test:server
npm run test:openshift
npm run test:deploy-assets
npm run test:native-assets
npm run test:container
npm run test:screens
```

What the tests cover:

- Go backend unit behavior
- dependency startup retry behavior
- TypeScript correctness
- OpenShift manifest structure
- namespace, PVC storage class, and internal registry assumptions
- Go 1.26 Docker build requirement
- Postgres 18 image requirement
- Postgres PVC mount and `PGDATA` requirement
- Android Gradle wrapper pin
- Android Studio Node path handling
- iOS Podfile presence
- mobile screen rendering through Playwright

Integration tests that require live Postgres and Redis are opt-in:

```sh
INTEGRATION_DATABASE_URL='postgres://phone_levelg:phone_levelg@localhost:5432/phone_levelg?sslmode=disable' \
INTEGRATION_REDIS_ADDR='localhost:6379' \
go test ./apps/server/... -run Integration
```

## Privacy Notes

The intended deployment model is private access through home networking or VPN.

Recommended operational constraints:

- keep OpenShift routes private or firewall-restricted
- expose LiveKit only through the same trusted network path
- use invite-code registration only for trusted users
- rotate secrets before using the app seriously
- back up Postgres and Redis PVCs according to the cluster storage policy

Message end-to-end encryption is not implemented yet. The app is private from a network-access perspective, but server administrators can still access backend data until message encryption is added.

## License

MIT. See `LICENSE`.
