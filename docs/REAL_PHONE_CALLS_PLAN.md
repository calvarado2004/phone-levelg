# Real Phone Call Delivery Plan

This plan tracks the work required for Phone LevelG to behave like a real phone app: incoming calls must ring even when the app is backgrounded, suspended, locked, or not currently open.

## Status

- Current foreground calls work through WebSocket signaling plus LiveKit media.
- Background/suspended incoming calls do not work yet because WebSocket delivery stops when the OS suspends the app.
- The correct path is native push delivery: APNs/PushKit + CallKit on iOS, and FCM + full-screen incoming-call notification or Telecom/ConnectionService on Android.

## Architecture Target

```mermaid
sequenceDiagram
  participant Caller as Caller app
  participant API as Go backend
  participant Store as Postgres devices table
  participant Push as APNs / FCM
  participant CalleeOS as Callee OS
  participant CalleeApp as Callee app
  participant LiveKit as LiveKit

  Caller->>API: WebSocket call:ring(roomId, mode, callId)
  API->>API: Validate room and target recipients
  API->>Store: Load callee device tokens by email-backed user id
  API-->>CalleeApp: WebSocket ring if app is active
  API->>Push: Send native call push to registered devices
  Push-->>CalleeOS: Wake device / display call affordance
  CalleeOS-->>CalleeApp: iOS PushKit or Android FCM handler
  CalleeApp-->>CalleeOS: Report incoming call UI
  CalleeOS-->>CalleeApp: Accept / decline action
  CalleeApp->>API: POST /calls/token or call:reject
  CalleeApp->>LiveKit: Join room on accept
```

## Tasks

### Planning And Current-State Mapping

- [x] Identify current foreground call path: WebSocket `call:ring`, `call:end`, `call:reject`.
- [x] Confirm LiveKit is media-only and backend currently only mints JWTs.
- [x] Confirm current limitation: no suspended-app delivery without native push.
- [x] Write this implementation plan and keep it updated as work progresses.

### Backend Device Registry

- [x] Add `devices` table to Postgres migration.
- [x] Key devices by normalized email-backed `user_id`.
- [x] Store `device_id`, `platform`, `push_token`, `push_token_type`, `app_version`, `created_at`, `last_seen_at`.
- [x] Add `POST /devices/register`.
- [x] Add `DELETE /devices/{deviceID}` or logout cleanup endpoint.
- [x] Add tests for registering, updating, and replacing device tokens.

### Backend Call Push Dispatch

- [x] Add call IDs to outgoing call attempts.
- [x] Add call expiration timestamp to ring payloads.
- [x] Resolve direct-call recipients by email-backed user id.
- [x] Keep WebSocket delivery as fast path for active clients.
- [x] Send native push to every registered recipient device through a provider abstraction.
- [x] Do not send push back to caller devices.
- [x] Add tests that `call:ring` dispatches both WebSocket and native push work.
- [x] Persist call attempts for retry/audit.
- [ ] Attach concrete APNs and FCM provider implementations.

### Push Providers And Secrets

- [ ] Add APNs provider configuration to backend.
- [ ] Add FCM provider configuration to backend.
- [ ] Store provider credentials in OpenShift secrets.
- [ ] Add deployment manifest/env wiring for APNs and FCM.
- [ ] Ensure missing push credentials fail gracefully in local development.

### iOS PushKit And CallKit

- [ ] Add native PushKit registration.
- [ ] Send VoIP token to `/devices/register`.
- [ ] Handle VoIP push while app is suspended.
- [ ] Immediately report incoming call through CallKit.
- [ ] Wire CallKit accept to LiveKit join.
- [ ] Wire CallKit decline/end to backend `call:reject` / `call:end`.
- [ ] Clear stale CallKit calls on expiration or remote end.
- [ ] Validate on a locked physical iPhone.

### Android FCM And Full-Screen Calls

- [x] Add first-pass FCM registration through Expo native device push tokens.
- [x] Send FCM token to `/devices/register`.
- [ ] Handle high-priority data message in background/killed states.
- [ ] Show full-screen incoming-call notification.
- [ ] Wire Accept and Decline notification actions.
- [ ] Reuse `rockstar.mp3` ringtone and vibration pattern.
- [ ] Validate on a locked Android device or emulator with Play Services.
- [ ] Evaluate Telecom/ConnectionService as a follow-up for deeper phone integration.

### Mobile App State And UX

- [x] Persist a stable per-install device id.
- [x] Register APNs/FCM-style native push token after login restore and successful login.
- [x] Re-register device when the native push token rotates.
- [x] Best-effort unregister current device on logout.
- [ ] Deduplicate foreground WebSocket ring and native push ring for the same `callId`.
- [ ] Persist pending incoming call metadata long enough for native action handling.
- [ ] Ensure expired pushes do not show call UI.
- [ ] Ensure caller sees `Call rejected`, `Call ended`, or `Unavailable`.
- [ ] Keep local and remote video behavior unchanged after push-based entry.

### Test Coverage

- [x] Add backend integration tests for device registration, token update, and logout delete.
- [x] Add backend unit coverage for rejecting invalid device registration payloads.
- [x] Add backend integration tests for call IDs, expiration, recipient resolution, and push fan-out.
- [x] Add backend integration tests for persisted call attempts and target device rows.
- [x] Add native project validation for mobile push-token registration wiring.
- [ ] Add backend tests for missing APNs/FCM credentials graceful behavior.
- [ ] Add iOS native tests or deterministic validation hooks for PushKit/CallKit accept, decline, and expiration.
- [ ] Add Android native tests or deterministic validation hooks for FCM background handling and full-screen actions.
- [ ] Add end-to-end call tests covering foreground, background, and locked-device paths.

### Deployment And Validation

- [x] Run backend unit tests.
- [x] Run mobile typecheck and native asset checks.
- [x] Deploy backend to OpenShift.
- [x] Build iOS Release app.
- [x] Build Android Release APK.
- [x] Install iOS Release app on both connected iPhones.
- [x] Install Android Release app on emulator/device.
- [ ] Test foreground call.
- [ ] Test iPhone locked/background incoming call.
- [ ] Test Android locked/background incoming call.
- [ ] Test direct-chat cleanup still works with email-backed user ids.

## Notes

- iOS VoIP pushes must be used only for real calls and must report to CallKit promptly.
- The first-pass iOS mobile registration stores a regular APNs notification token. PushKit VoIP token registration is still required before locked/suspended iPhone calls can be considered complete.
- APNs/FCM credentials must never be committed to the repository.
- Email remains the stable user identity. Display name is presentation only.
- Push delivery complements WebSocket signaling; it does not replace LiveKit for media.
