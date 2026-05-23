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

- invite-code login
- room message history
- WebSocket live events
- LiveKit token minting
- OpenShift health checks

Postgres owns durable data. Redis lets multiple backend replicas broadcast room events without sticky sessions.

## Mobile

The mobile app is React Native through Expo so one codebase targets iOS and Android.

The first MVP has one private room called `Home`. That keeps the product focused while the infrastructure is being proven.

## Calls

The backend does not carry media. It only creates LiveKit JWTs. Mobile clients connect directly to LiveKit for audio/video media.

OpenShift exposes LiveKit with MetalLB on the libvirt network. The host forwards LAN/VPN traffic to that LoadBalancer IP:

- `7880/TCP`: signaling
- `7881/TCP`: TCP media fallback
- `50100-50120/UDP`: media

The mobile OpenShift build points `EXPO_PUBLIC_LIVEKIT_URL` at `ws://192.168.1.88:7880`.

## Privacy Model

The app is intended to be reachable only from the home network or VPN:

- OpenShift Routes should be private or firewall-restricted.
- Registration is controlled by an invite code.
- LiveKit should be exposed only to the same trusted network path.

End-to-end encryption for message bodies is not implemented yet. That should be added before treating the system as sensitive/private against server administrators.

## State Choices

- Postgres: users and messages.
- Redis: live delivery coordination.
MongoDB is intentionally not deployed. The MVP only needs Postgres and Redis, which keeps backups, migrations, monitoring, and failure recovery simpler.
