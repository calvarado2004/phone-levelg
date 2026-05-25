# Phone LevelG Mobile

React Native / Expo client for iOS and Android.

## Screens

- Google-email account login with a separate server URL and server secret.
- Single private `Home` room.
- Lobby/contact strip showing joined members.
- Hidden 1-1 chats opened from a lobby member.
- Direct chat deletion.
- Real-time messages over WebSocket.
- Client-side encrypted message bodies for new messages.
- Encrypted photo and document attachments in 1-1 chats.
- Optional private-message notification sound for 1-1 chats only; the lobby remains silent.
- Quick emoji reactions.
- Compact cat meme quick messages.
- Voice/video call join through LiveKit.
- 30-day local session persistence.
- Header logout.
- User photos from Google profile pictures with initials fallback.
- Incoming call alerts use the bundled `rockstar.mp3` ringtone through the native notification sound path.

## Runtime Configuration

```sh
EXPO_PUBLIC_API_URL=http://localhost:4000
EXPO_PUBLIC_LIVEKIT_URL=ws://localhost:7880
EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID=...
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=...
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=...
```

The login screen defaults the server URL to the OpenShift route:

```text
https://phone-levelg-server-phone-levelg.apps.ocp-think.levelg.io
```

For emulator-only local testing, enter the Docker Compose API URL in the server URL box. For physical devices, use a LAN, VPN, or OpenShift-reachable hostname instead of `localhost`.

Native release builds default LiveKit to `ws://192.168.1.88:7880` so Android and iOS use the same reachable WebRTC endpoint. Keep local LiveKit configured with that node IP and the mapped UDP range before validating calls.

## Installation

Always install release builds on Android emulators, Android devices, iOS simulators, and iOS devices. Do not use debug builds for validation unless you are specifically debugging Metro or native development tooling.

Google sign-in uses Expo AuthSession. Configure OAuth clients in Google Cloud for the app package/bundle ID and register the native redirect URI generated for the app scheme:

```text
phonelevelg://oauthredirect
```

The Google email identifies the user account. The server URL selects the backend, and the server secret is the invite code for that backend.

Display names are presentation-only. The backend allows two accounts to use the same display name because the stable identity is the normalized Google email.

## Chat Model

The lobby shows members, not private chat rooms. Tapping a member opens a deterministic 1-1 room computed from both user IDs. Other members do not see that room and cannot fetch its message history.

Direct chats can be deleted from the selected private conversation. Deletion clears the room history and broadcasts a clear event only to the two participants.

New message bodies are encrypted before they are sent to the backend. The server stores and relays opaque `plgenc:v1` envelopes, and this app decrypts history and live websocket messages locally. Existing plaintext rows remain readable during rollout.

Photo and document attachments are available only inside 1-1 chats. File bytes are loaded from picker-provided base64 data when available, with app-cache/content URI fallbacks, then encrypted locally before upload. Filename/type metadata is carried inside the encrypted `plgattach:v1` chat message so the backend only stores opaque blobs.

iOS must declare `NSPhotoLibraryUsageDescription` for picture selection. Android must declare `READ_MEDIA_IMAGES` on modern devices and `READ_EXTERNAL_STORAGE` with `maxSdkVersion=32` for older devices.

Private 1-1 message notifications use `message-notification.mp3`, packaged as `message-notification.mp3` on iOS and `message_notification.mp3` in Android raw resources. The sound is controlled by the in-app private-message sound toggle and is never used for lobby messages.

## Background Delivery

The app keeps the login session for 30 days and reconnects the WebSocket when the app is active again. True WhatsApp-style background call/message delivery requires server-triggered APNs/FCM push notifications plus native incoming-call integration:

- iOS: PushKit/CallKit for full incoming-call UI while suspended.
- Android: FCM plus a high-priority incoming-call notification or Telecom/ConnectionService integration.

The current in-app incoming-call alert uses the system notification sound while the app process is able to receive the WebSocket event.

## Design Direction

The UI follows common modern messaging patterns:

- compact conversation header with avatar, online state, and call actions
- purple app theme aligned with the launcher icon
- soft conversation background for readability
- horizontal member lobby for visible joined contacts
- asymmetric message bubbles with timestamps outside the message body
- quick emoji strip near the composer
- persistent call banner with a direct hang-up control

## Tests

The app currently has TypeScript checking from the beginning:

```sh
npm run typecheck -w apps/mobile
```

Component tests should be added once navigation and multiple screens are introduced.
