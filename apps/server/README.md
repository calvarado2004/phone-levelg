# Phone LevelG Server

Go backend for the private messaging and call-token API.

## Responsibilities

- Login through a Google email account plus a shared invite code.
- Reuse users by normalized email while allowing duplicate display names.
- Store users, joined members, opaque encrypted message envelopes, and encrypted attachment blobs in Postgres.
- Keep direct chat rooms private to their two participants.
- Delete direct chat history when requested by a participant.
- Broadcast live chat, member join, and call events through Redis pub/sub.
- Register native APNs/PushKit/FCM device tokens.
- Queue APNs/FCM private-message and call pushes without blocking message persistence.
- Mint LiveKit room tokens for voice/video calls.
- Expose health checks for OpenShift probes.

## API

### `GET /healthz`

Checks Postgres and Redis connectivity.

### `POST /login`

Request:

```json
{
  "displayName": "Carlos",
  "accountEmail": "carlos@example.com",
  "inviteCode": "home"
}
```

Response:

```json
{
  "userId": "generated-id",
  "displayName": "Carlos",
  "accountEmail": "carlos@example.com"
}
```

`accountEmail` is the stable account key. `displayName` is presentation-only and can change without creating a second member. Different email accounts may use the same display name. The invite code remains the backend-specific server secret.

### `GET /rooms/{roomID}/messages`

Returns the latest 200 messages for a room in chronological order. New mobile clients write encrypted `plgenc:v1` envelopes in the `text` field and decrypt them locally.

For 1-1 rooms (`dm:{userA}:{userB}`), callers must include `?userId=...`; only the two room members can read the history.

### `POST /rooms/{roomID}/messages/delivered`

Marks direct messages as delivered for the recipient account and consumes pending APNs/FCM message delivery attempts.

### `POST /rooms/{roomID}/messages/read`

Marks direct messages as read for the recipient account and broadcasts `message:read` to the direct-room participants. Read receipts are UI state; delivered receipts are what stop pending push delivery work.

### `POST /rooms/{roomID}/attachments`

Stores an opaque encrypted attachment blob for a direct chat. The request body is:

```json
{
  "senderId": "alice",
  "data": "base64-ciphertext"
}
```

Lobby attachments are rejected.

### `GET /rooms/{roomID}/attachments/{attachmentID}?userId=...`

Returns the encrypted attachment blob to a direct-room participant. The backend does not store readable filename or MIME metadata; mobile clients put that data in the encrypted `plgattach:v1` message envelope.

### `DELETE /rooms/{roomID}/messages?userId=...`

Deletes all messages in a 1-1 room and publishes a `message:clear` event to both members. Lobby room deletion is rejected so shared history is not removed accidentally.

### `GET /members`

Returns the most recently seen users for the mobile lobby/contact strip.

### `GET /ws?roomId=home&userId=...&displayName=...`

WebSocket endpoint.

Client send event:

```json
{
  "type": "message:send",
  "data": {
    "text": "plgenc:v1:base64-nonce:base64-ciphertext"
  }
}
```

Server broadcast event:

```json
{
  "type": "message:new",
  "data": {
    "id": "...",
    "roomId": "home",
    "senderId": "...",
    "sender": "Carlos",
    "text": "hello 👋",
    "createdAt": "2026-05-23T12:00:00Z"
  }
}
```

Member join broadcast event:

```json
{
  "type": "member:joined",
  "data": {
    "id": "...",
    "displayName": "Carlos",
    "lastSeenAt": "2026-05-23T12:00:00Z"
  }
}
```

### `POST /calls/token`

Mints a LiveKit JWT for a room.

### `POST /devices/register`

Registers or refreshes one native push token for the logged-in account. iOS registers both a regular APNs alert token for private-message notifications and a PushKit VoIP token for real calls. Android registers an FCM token for private messages and high-priority incoming-call data pushes.

## Native Push

The server sends native pushes asynchronously through an in-process queue sized for bursts. APNs provider JWTs are cached before expiration to avoid Apple `TooManyProviderTokenUpdates`, and APNs `429` / `5xx` responses are retried with backoff. WebSocket delivery remains the fast path when the recipient app is active.

## Identity and Privacy

The backend does not use display names as identifiers. Login normalizes `accountEmail`, updates an existing row when that email already exists, and creates a new row only for a new email. This avoids duplicate-account errors when two users choose the same name.

Direct rooms use this format:

```text
dm:{lowerUserID}:{higherUserID}
```

The mobile client sorts the two user IDs before constructing the room ID, so both devices address the same room. The backend checks that `userId` is one of the two participants before returning history, accepting messages, or deleting that room history.

Message bodies and attachment blobs are intentionally opaque to the backend. The server validates size and room access, stores ciphertext, and relays message envelopes through Redis/WebSocket without decrypting them.

## State

- Postgres is the durable system of record.
- Redis is ephemeral coordination for live events.

## Tests

Unit tests run without external services:

```sh
go test ./apps/server/...
```

Integration tests are opt-in and require real Postgres and Redis endpoints:

```sh
INTEGRATION_DATABASE_URL='postgres://phone_levelg:phone_levelg@localhost:5432/phone_levelg?sslmode=disable' \
INTEGRATION_REDIS_ADDR='localhost:6379' \
go test ./apps/server/... -run Integration
```

The login-specific regression subset is:

```sh
INTEGRATION_DATABASE_URL='postgres://phone_levelg:phone_levelg@localhost:5432/phone_levelg?sslmode=disable' \
INTEGRATION_REDIS_ADDR='localhost:6379' \
go test ./apps/server/... -run 'TestIntegrationLogin'
```
