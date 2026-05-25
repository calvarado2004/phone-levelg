# Architecture

Phone LevelG is a private mobile communication app for home/VPN use.

## High-Level Layout

```text
iOS / Android app
  |
  | Native Google Sign-In SDK
  v
Google Identity
  |
  | verified email/profile token
  v
iOS / Android app
  |
  | HTTPS + WebSocket over LAN/VPN
  v
Go backend on OpenShift
  | \
  |  \-- Redis: live room events, call rings, fan-out
  |
  \----- Postgres: users, rooms, encrypted message envelopes, encrypted attachment blobs

LiveKit
  |
  \-- WebRTC media for voice/video calls on host-forwarded LAN/VPN ports
```

## Backend

The backend is intentionally small:

- Google-email account login with invite-code backend access
- backend verification of Google access tokens through `userinfo`
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
- client-side encrypted message bodies for new chat messages
- client-side encrypted picture and document attachments for 1-1 chats
- emoji and cat-meme quick actions
- Google profile photos or initials for user avatars
- a logout action in the header
- foreground incoming-call UI and platform notification sounds

Android and iOS use `@react-native-google-signin/google-signin` for the account picker and token issuance. The older browser OAuth/AuthSession path remains available only for web/dev browser execution, because Google's mobile OAuth policy rejects insecure custom-scheme browser redirects on native apps.

Private conversations are not discoverable as lobby objects. Both clients compute the same direct room ID from the two user IDs, and the backend rejects direct-room access from any other user.

## Calls

The backend does not carry media. It only creates LiveKit JWTs. Mobile clients connect directly to LiveKit for audio/video media.

OpenShift exposes LiveKit with MetalLB on the libvirt network. The host forwards LAN/VPN traffic to that LoadBalancer IP:

- `7880/TCP`: signaling
- `7881/TCP`: TCP media fallback
- `50100-50120/UDP`: media

The mobile OpenShift build points `EXPO_PUBLIC_LIVEKIT_URL` at `ws://192.168.1.88:7880`.

Full suspended-app incoming call behavior is a native/push concern:

- iOS uses APNs/PushKit plus CallKit.
- Android uses FCM plus high-priority full-screen call notifications.

The current implementation registers device push tokens, sends native call pushes, shows native incoming-call UI, and obtains LiveKit tokens from the backend. Locked/background physical-device validation remains the main risk area.

## Privacy Model

The app is intended to be reachable only from the home network or VPN:

- OpenShift Routes should be private or firewall-restricted.
- Registration is controlled by an invite code.
- User identity is keyed by normalized Google email, while the selected server URL and invite code choose which private backend to join.
- Private 1-1 message history requires participant authorization on every request.
- LiveKit should be exposed only to the same trusted network path.

New message bodies and 1-1 attachment bytes are encrypted on the mobile client before they are sent to the backend. The backend stores and relays opaque `plgenc:v1` message envelopes plus encrypted attachment blobs; mobile clients decrypt fetched history, websocket `message:new` payloads, and downloaded files locally with `tweetnacl` secretbox.

Current limitation: this first phase derives room keys from the private invite code plus room ID. That removes plaintext message bodies from backend storage and relay, but the stronger target remains per-account/per-device key material with encrypted room-key fan-out for up to three devices per Gmail account.

## State Choices

- Postgres: users, encrypted message envelopes, and encrypted attachment blobs.
- Redis: live delivery coordination.
