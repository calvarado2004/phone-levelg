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
│   ├── local               # Local LiveKit config used by Docker Compose
│   └── openshift           # OpenShift manifests
├── docs
│   ├── ARCHITECTURE.md     # Architecture notes
│   └── screenshots         # Mobile app screenshots
├── tests
│   ├── deploy              # Container/deploy asset checks
│   ├── mobile              # Native project asset checks
│   └── openshift           # Manifest validation
└── docker-compose.yml      # Local Postgres/Redis/LiveKit
```

## Screenshots

| Home and lobby | Private chat | Incoming call |
| --- | --- | --- |
| ![Phone LevelG home and lobby](docs/screenshots/phoneApp01.png) | ![Phone LevelG private chat](docs/screenshots/phoneApp02.png) | ![Phone LevelG incoming call](docs/screenshots/phoneApp03.png) |

| Voice call | Video call |
| --- | --- |
| ![Phone LevelG voice call](docs/screenshots/phoneApp04.png) | ![Phone LevelG video call](docs/screenshots/phoneApp05.png) |

## Technology Architecture

```mermaid
flowchart LR
  subgraph Clients["Native clients"]
    Android["Android app\nReact Native + Expo\nRelease APK"]
    IOS["iOS app\nReact Native + Expo\nRelease app"]
  end

  subgraph Backend["Private backend"]
    API["Go 1.26 API\nchi router"]
    PG["Postgres 18\nusers + messages"]
    Redis["Redis 7\npub/sub fan-out"]
    LK["LiveKit\nWebRTC SFU"]
  end

  Android -->|"HTTPS\nlogin, members, messages, call tokens"| API
  IOS -->|"HTTPS\nlogin, members, messages, call tokens"| API
  Android -->|"WebSocket\nchat, presence, call ring/end/reject"| API
  IOS -->|"WebSocket\nchat, presence, call ring/end/reject"| API
  API -->|"SQL"| PG
  API -->|"publish / subscribe"| Redis
  API -->|"JWT minting\n/calls/token"| LK
  Android -->|"WebRTC media\nvoice/video"| LK
  IOS -->|"WebRTC media\nvoice/video"| LK
```

The backend does not carry audio or video media. It validates identity, stores messages, publishes signaling events, and issues LiveKit JWTs. Mobile clients use those tokens to connect directly to LiveKit for WebRTC media.

```mermaid
sequenceDiagram
  participant Caller as Android/iOS caller
  participant API as Go API
  participant Callee as Android/iOS callee
  participant LiveKit as LiveKit

  Caller->>API: POST /calls/token
  API-->>Caller: LiveKit room JWT
  Caller->>LiveKit: Join room and publish microphone/camera
  Caller->>API: WebSocket call:ring(roomId, mode)
  API-->>Callee: WebSocket call:ring
  Callee-->>Callee: Full-screen incoming-call UI + rockstar ringtone
  Callee->>API: POST /calls/token
  API-->>Callee: LiveKit room JWT
  Callee->>LiveKit: Join same room and publish media
  LiveKit-->>Caller: Remote audio/video tracks
  LiveKit-->>Callee: Remote audio/video tracks
```

```mermaid
flowchart TB
  subgraph Local["Local development"]
    Compose["docker compose"]
    LocalAPI["Go API :4000"]
    LocalPG["Postgres :5432"]
    LocalRedis["Redis :6379"]
    LocalLiveKit["LiveKit :7880/:7881\nUDP 50100-50120"]
  end

  subgraph OCP["OpenShift deployment"]
    Route["Private OpenShift route"]
    Build["Binary BuildConfig\ninternal registry image"]
    Deploy["Go API Deployment"]
    OcpPG["Postgres StatefulSet\npx-csi-db PVC"]
    OcpRedis["Redis StatefulSet\npx-csi-db PVC"]
    OcpLiveKit["LiveKit Deployment\nLoadBalancer + host forward"]
  end

  Compose --> LocalAPI
  Compose --> LocalPG
  Compose --> LocalRedis
  Compose --> LocalLiveKit
  Route --> Deploy
  Build --> Deploy
  Deploy --> OcpPG
  Deploy --> OcpRedis
  Deploy --> OcpLiveKit
```

### Implementation Details

| Area | Technology | Implementation |
| --- | --- | --- |
| Mobile UI | React Native, Expo, TypeScript | The main app surface is in `apps/mobile/App.tsx`. It handles login, lobby presence, direct chats, message rendering, call controls, incoming-call overlays, and full-screen voice/video call layouts. |
| Native shells | Android Gradle project, iOS Xcode project | Native projects live under `apps/mobile/android` and `apps/mobile/ios`. Release builds are used for emulator, simulator, and device validation. |
| Calling UI | LiveKit React Native, WebRTC, Expo notifications | Calls use a phone-style full-screen surface. Video calls show the remote video, the contact icon/name header, `Calling <contact-name>`, and a bottom-right local camera preview. Incoming calls use the bundled `rockstar.mp3` ringtone. |
| Identity | Google email plus invite code | The backend keys accounts by normalized `accountEmail`. Display names are presentation-only and can overlap across users. |
| Backend API | Go 1.26, chi, pgx, gorilla/websocket | The API validates logins, stores messages, enforces direct-room access, maintains websocket sessions, and mints LiveKit tokens. |
| Durable state | Postgres 18 | Users and messages are stored in Postgres. OpenShift uses a `px-csi-db` PVC with `PGDATA` below the mounted PVC root. |
| Live events | Redis 7 | Redis pub/sub fans out chat, presence, direct-room deletion, and call signaling events across backend instances. |
| Media | LiveKit | LiveKit carries the actual voice/video media. Local Docker and OpenShift configs advertise a reachable node IP and mapped WebRTC ports so clients do not try to connect to container or pod IPs. |
| Deployment | Docker Compose, OpenShift, internal registry | Docker Compose runs local state and LiveKit. OpenShift manifests create the namespace, stateful services, backend build/deploy resources, routes, and LiveKit networking. |
| Validation | Go tests, TypeScript, native asset checks, Playwright | Tests cover backend behavior, deployment assumptions, native project assets, mobile build assumptions, and screen rendering. |

## Runtime Components

### Mobile App

The mobile app lives in `apps/mobile`.

It provides:

- invite-code login
- Google email identity decoupled from the backend server secret
- 30-day local session persistence
- logout from the mobile header
- user avatars from Google profile photos, with initials fallback
- joined-member lobby backed by Postgres
- shared `Home` lobby room
- private 1-1 chats between members
- private-chat deletion from the selected direct conversation
- real-time messages over WebSocket
- emoji quick actions
- compact cat meme quick messages
- call buttons for LiveKit-backed voice/video rooms
- incoming-call UI while the app is active, using bundled `rockstar.mp3`
- phone-style full-screen voice/video calls
- contact icon and `Calling <contact-name>` header during calls
- bottom-right self camera preview during video calls
- native Android and iOS projects for IDE/device builds

Important environment variables:

```sh
EXPO_PUBLIC_API_URL=https://your-private-api-host
EXPO_PUBLIC_LIVEKIT_URL=wss://your-private-livekit-host
EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID=your-android-oauth-client-id
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=your-ios-oauth-client-id
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=your-web-oauth-client-id
```

The login screen keeps these pieces separate:

- Google email: the stable account key.
- Display name: presentation only.
- Server URL: the backend to connect to, defaulting to the private OpenShift route.
- Server secret: the backend invite code.

User identity is keyed by normalized `accountEmail`, not by display name. Multiple users can share the same display name without colliding. Re-login with the same email updates the existing member row, display name, avatar URL, and `last_seen_at`.

The lobby only lists members. It does not list private 1-1 rooms. Direct room IDs are derived from the two user IDs as `dm:{userA}:{userB}` with sorted IDs, so both devices address the same private conversation. Backend access checks require the requesting user to be one of those two participants before returning direct-message history or accepting direct-message writes.

For local development, the server URL can be changed directly in the app login screen. Emulator/simulator backend defaults are still useful when building with local environment variables:

```text
EXPO_PUBLIC_API_URL=http://localhost:4000
EXPO_PUBLIC_LIVEKIT_URL=ws://localhost:7880
```

For physical devices, use an address reachable from the device over LAN or VPN. Do not use `localhost` unless the API is running on the device itself.

Native release builds default LiveKit to `ws://192.168.1.88:7880` so Android and iOS use the same reachable WebRTC endpoint. Local Docker LiveKit uses `deploy/local/livekit.yaml` to advertise `192.168.1.88`, TCP `7881`, and UDP `50100-50120`.

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

Emulator/simulator API defaults point at the laptop-local Docker Compose stack:

- Android emulator: `http://10.0.2.2:4000`
- iOS Simulator: `http://localhost:4000`

Always install release builds on Android emulators, Android devices, iOS simulators, and iOS devices. Debug builds should be reserved for Metro or native tooling work.

### Go Backend

The backend lives in `apps/server` and is built with Go 1.26.

Responsibilities:

- validate invite-code login
- create and update users by normalized account email
- allow duplicate display names across different emails
- persist messages in Postgres
- return room history
- keep 1-1 rooms private to their two members
- delete a direct chat history on request from either participant
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

The app keeps calls in the foreground app experience. Native full-screen incoming calls while the app is suspended still require production push infrastructure: APNs/PushKit plus CallKit on iOS, and FCM plus high-priority notifications or ConnectionService on Android.

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

Creates or updates a session identity after invite-code validation. `accountEmail` is the stable account key; `displayName` is presentation-only.

```json
{
  "displayName": "User",
  "accountEmail": "user@example.com",
  "inviteCode": "home"
}
```

Two users may have the same `displayName` if their `accountEmail` values are different.

### `GET /rooms/{roomID}/messages`

Returns the latest room messages in chronological order.

For direct rooms, pass `?userId=...`; non-participants receive `403`.

### `DELETE /rooms/{roomID}/messages`

Deletes a direct chat history when called by one of its two participants:

```text
DELETE /rooms/dm:{userA}:{userB}/messages?userId={userA}
```

Lobby room deletion is rejected.

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

The current mobile call path verifies signaling, LiveKit token minting, room join, microphone/camera permissions, full-screen call UI, remote video rendering, and local camera preview.

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
- email-keyed login and duplicate display-name regression coverage
- direct-room privacy checks
- direct-chat deletion behavior
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

The login-specific integration subset is useful before deploying identity changes:

```sh
INTEGRATION_DATABASE_URL='postgres://phone_levelg:phone_levelg@localhost:5432/phone_levelg?sslmode=disable' \
INTEGRATION_REDIS_ADDR='localhost:6379' \
go test ./apps/server/... -run 'TestIntegrationLogin'
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
