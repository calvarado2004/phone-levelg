# Phone LevelG Mobile

React Native / Expo client for iOS and Android.

## Screens

- Invite-code login.
- Single private `Home` room.
- Lobby/contact strip showing joined members.
- Real-time messages over WebSocket.
- Quick emoji reactions.
- Voice/video call join through LiveKit.

## Runtime Configuration

```sh
EXPO_PUBLIC_API_URL=http://localhost:4000
EXPO_PUBLIC_LIVEKIT_URL=ws://localhost:7880
```

For physical devices, use a LAN or VPN-reachable hostname instead of `localhost`.

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
