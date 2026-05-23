# Architecture

Phone LevelG is a private mobile communication app for home/VPN use.

## High-Level Layout

```text
iOS / Android app
  |
  | HTTPS + WebSocket over LAN/VPN
  v
Go backend on OpenShift
  | \
  |  \-- Redis: live room events, call rings, fan-out
  |
  \----- Postgres: users, rooms, messages

LiveKit
  |
  \-- WebRTC media for voice/video calls on host-forwarded LAN/VPN ports
```

## Backend

The backend is intentionally small:

- Google-email account login with invite-code backend access
- email-keyed users with mutable display names and avatar URLs
- room message history
- shared lobby membership
- private 1-1 room access checks
- direct-chat deletion
- WebSocket live events
- LiveKit token minting
- OpenShift health checks

Postgres owns durable data. Redis lets multiple backend replicas broadcast room events without sticky sessions.

## Mobile

The mobile app is React Native through Expo so one codebase targets iOS and Android.

The first screen is the actual chat experience after login. The app has:

- a shared `Home` lobby room
- a member strip for contacts
- hidden private 1-1 conversations selected by tapping a member
- emoji and cat-meme quick actions
- Google profile photos or initials for user avatars
- a logout action in the header
- foreground incoming-call UI and platform notification sounds

Private conversations are not discoverable as lobby objects. Both clients compute the same direct room ID from the two user IDs, and the backend rejects direct-room access from any other user.

## Calls

The backend does not carry media. It only creates LiveKit JWTs. Mobile clients connect directly to LiveKit for audio/video media.

OpenShift exposes LiveKit with MetalLB on the libvirt network. The host forwards LAN/VPN traffic to that LoadBalancer IP:

- `7880/TCP`: signaling
- `7881/TCP`: TCP media fallback
- `50100-50120/UDP`: media

The mobile OpenShift build points `EXPO_PUBLIC_LIVEKIT_URL` at `ws://192.168.1.88:7880`.

Full suspended-app incoming call behavior is a native/push concern:

- iOS requires APNs/PushKit plus CallKit.
- Android requires FCM plus high-priority notifications or ConnectionService.

The current implementation handles calls while the app is active and obtains LiveKit tokens from the backend.

## Privacy Model

The app is intended to be reachable only from the home network or VPN:

- OpenShift Routes should be private or firewall-restricted.
- Registration is controlled by an invite code.
- User identity is keyed by normalized Google email, while the selected server URL and invite code choose which private backend to join.
- Private 1-1 message history requires participant authorization on every request.
- LiveKit should be exposed only to the same trusted network path.

End-to-end encryption for message bodies is not implemented yet. That should be added before treating the system as sensitive/private against server administrators.

## State Choices

- Postgres: users and messages.
- Redis: live delivery coordination.
MongoDB is intentionally not deployed. The MVP only needs Postgres and Redis, which keeps backups, migrations, monitoring, and failure recovery simpler.
