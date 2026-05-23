# Phone LevelG Server

Go backend for the private messaging and call-token API.

## Responsibilities

- Login through a shared invite code.
- Store users, joined members, and messages in Postgres.
- Broadcast live chat, member join, and call events through Redis pub/sub.
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
  "inviteCode": "home"
}
```

Response:

```json
{
  "userId": "generated-id",
  "displayName": "Carlos"
}
```

### `GET /rooms/{roomID}/messages`

Returns the latest 200 messages for a room in chronological order.

### `GET /members`

Returns the most recently seen users for the mobile lobby/contact strip.

### `GET /ws?roomId=home&userId=...&displayName=...`

WebSocket endpoint.

Client send event:

```json
{
  "type": "message:send",
  "data": {
    "text": "hello 👋"
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

## State

- Postgres is the durable system of record.
- Redis is ephemeral coordination for live events.
MongoDB is not used or deployed in the MVP. It can be introduced later only if a document-heavy feature actually needs it.

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
