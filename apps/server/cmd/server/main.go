package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/livekit/protocol/auth"
	"github.com/redis/go-redis/v9"
)

type config struct {
	port             string
	corsOrigin       string
	sharedInviteCode string
	databaseURL      string
	redisAddr        string
	livekitAPIKey    string
	livekitAPISecret string
	apnsTeamID       string
	apnsKeyID        string
	apnsBundleID     string
	apnsPrivateKey   string
	apnsEndpoint     string
	fcmProjectID     string
	fcmAccessToken   string
	fcmEndpoint      string
}

type server struct {
	cfg      config
	db       *pgxpool.Pool
	redis    *redis.Client
	upgrader websocket.Upgrader
	push     pushDispatcher
}

type loginRequest struct {
	DisplayName  string `json:"displayName"`
	AccountEmail string `json:"accountEmail"`
	AvatarURL    string `json:"avatarURL"`
	InviteCode   string `json:"inviteCode"`
}

type loginResponse struct {
	UserID       string `json:"userId"`
	DisplayName  string `json:"displayName"`
	AccountEmail string `json:"accountEmail"`
	AvatarURL    string `json:"avatarURL,omitempty"`
}

type member struct {
	ID          string    `json:"id"`
	DisplayName string    `json:"displayName"`
	AvatarURL   string    `json:"avatarURL,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
	LastSeenAt  time.Time `json:"lastSeenAt"`
}

type message struct {
	ID        string    `json:"id"`
	RoomID    string    `json:"roomId"`
	SenderID  string    `json:"senderId"`
	Sender    string    `json:"sender"`
	Text      string    `json:"text"`
	CreatedAt time.Time `json:"createdAt"`
}

type deviceRegistrationRequest struct {
	UserID        string `json:"userId"`
	DeviceID      string `json:"deviceId"`
	Platform      string `json:"platform"`
	PushToken     string `json:"pushToken"`
	PushTokenType string `json:"pushTokenType"`
	AppVersion    string `json:"appVersion"`
}

type deviceRegistrationResponse struct {
	UserID        string    `json:"userId"`
	DeviceID      string    `json:"deviceId"`
	Platform      string    `json:"platform"`
	PushTokenType string    `json:"pushTokenType"`
	AppVersion    string    `json:"appVersion,omitempty"`
	LastSeenAt    time.Time `json:"lastSeenAt"`
}

type pushDevice struct {
	DeviceID      string
	UserID        string
	Platform      string
	PushToken     string
	PushTokenType string
}

type callPushPayload struct {
	CallID    string    `json:"callId"`
	RoomID    string    `json:"roomId"`
	SenderID  string    `json:"senderId"`
	Sender    string    `json:"sender"`
	Mode      string    `json:"mode"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type pushDispatcher interface {
	DispatchCallPush(context.Context, callPushPayload, []pushDevice) error
}

type noopPushDispatcher struct{}

func (noopPushDispatcher) DispatchCallPush(context.Context, callPushPayload, []pushDevice) error {
	return nil
}

type compositePushDispatcher struct {
	apns *apnsProvider
	fcm  *fcmProvider
}

func buildPushDispatcher(cfg config) pushDispatcher {
	dispatcher := compositePushDispatcher{
		apns: newAPNSProvider(cfg),
		fcm:  newFCMProvider(cfg),
	}
	if dispatcher.apns == nil && dispatcher.fcm == nil {
		slog.Info("native push providers disabled; missing APNs/FCM credentials")
		return noopPushDispatcher{}
	}
	return dispatcher
}

func (d compositePushDispatcher) DispatchCallPush(ctx context.Context, payload callPushPayload, devices []pushDevice) error {
	var lastErr error
	for _, device := range devices {
		switch device.PushTokenType {
		case "apns", "apns-voip":
			if d.apns == nil {
				slog.Info("skip apns call push; provider disabled", "deviceID", device.DeviceID, "userID", device.UserID)
				continue
			}
			if err := d.apns.SendCallPush(ctx, payload, device); err != nil {
				lastErr = err
				slog.Error("send apns call push", "deviceID", device.DeviceID, "userID", device.UserID, "error", err)
			}
		case "fcm":
			if d.fcm == nil {
				slog.Info("skip fcm call push; provider disabled", "deviceID", device.DeviceID, "userID", device.UserID)
				continue
			}
			if err := d.fcm.SendCallPush(ctx, payload, device); err != nil {
				lastErr = err
				slog.Error("send fcm call push", "deviceID", device.DeviceID, "userID", device.UserID, "error", err)
			}
		default:
			slog.Info("skip unsupported push token type", "deviceID", device.DeviceID, "pushTokenType", device.PushTokenType)
		}
	}
	return lastErr
}

type apnsProvider struct {
	teamID     string
	keyID      string
	bundleID   string
	privateKey *ecdsa.PrivateKey
	endpoint   string
	client     *http.Client
}

func newAPNSProvider(cfg config) *apnsProvider {
	if cfg.apnsTeamID == "" || cfg.apnsKeyID == "" || cfg.apnsBundleID == "" || cfg.apnsPrivateKey == "" {
		return nil
	}
	key, err := parseAPNSPrivateKey(cfg.apnsPrivateKey)
	if err != nil {
		slog.Error("disable apns provider; invalid private key", "error", err)
		return nil
	}
	return &apnsProvider{
		teamID:     cfg.apnsTeamID,
		keyID:      cfg.apnsKeyID,
		bundleID:   cfg.apnsBundleID,
		privateKey: key,
		endpoint:   strings.TrimRight(cfg.apnsEndpoint, "/"),
		client:     &http.Client{Timeout: 10 * time.Second},
	}
}

func (p *apnsProvider) SendCallPush(ctx context.Context, payload callPushPayload, device pushDevice) error {
	token, err := p.authorizationToken(time.Now())
	if err != nil {
		return err
	}
	body, err := json.Marshal(apnsCallPayload(payload))
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint+"/3/device/"+device.PushToken, bytes.NewReader(body))
	if err != nil {
		return err
	}
	pushType := "alert"
	topic := p.bundleID
	if device.PushTokenType == "apns-voip" {
		pushType = "voip"
		topic += ".voip"
	}
	req.Header.Set("authorization", "bearer "+token)
	req.Header.Set("apns-topic", topic)
	req.Header.Set("apns-push-type", pushType)
	req.Header.Set("apns-priority", "10")
	req.Header.Set("content-type", "application/json")

	resp, err := p.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("apns returned %s", resp.Status)
	}
	return nil
}

func (p *apnsProvider) authorizationToken(now time.Time) (string, error) {
	header := map[string]string{"alg": "ES256", "kid": p.keyID}
	claims := map[string]any{"iss": p.teamID, "iat": now.Unix()}
	unsigned, err := jwtUnsigned(header, claims)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256([]byte(unsigned))
	r, s, err := ecdsa.Sign(rand.Reader, p.privateKey, hash[:])
	if err != nil {
		return "", err
	}
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(fixedECDSASignature(r, s, 32)), nil
}

type fcmProvider struct {
	projectID   string
	accessToken string
	endpoint    string
	client      *http.Client
}

func newFCMProvider(cfg config) *fcmProvider {
	if cfg.fcmProjectID == "" || cfg.fcmAccessToken == "" {
		return nil
	}
	endpoint := strings.TrimSpace(cfg.fcmEndpoint)
	if endpoint == "" {
		endpoint = "https://fcm.googleapis.com/v1/projects/" + cfg.fcmProjectID + "/messages:send"
	}
	return &fcmProvider{
		projectID:   cfg.fcmProjectID,
		accessToken: cfg.fcmAccessToken,
		endpoint:    endpoint,
		client:      &http.Client{Timeout: 10 * time.Second},
	}
}

func (p *fcmProvider) SendCallPush(ctx context.Context, payload callPushPayload, device pushDevice) error {
	body, err := json.Marshal(fcmCallPayload(payload, device.PushToken))
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("authorization", "Bearer "+p.accessToken)
	req.Header.Set("content-type", "application/json")

	resp, err := p.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("fcm returned %s", resp.Status)
	}
	return nil
}

type callTokenRequest struct {
	RoomID      string `json:"roomId"`
	Identity    string `json:"identity"`
	DisplayName string `json:"displayName"`
}

type createMessageRequest struct {
	SenderID    string `json:"senderId"`
	DisplayName string `json:"displayName"`
	Text        string `json:"text"`
}

type wsEnvelope struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data,omitempty"`
}

type outboundEnvelope struct {
	Type string `json:"type"`
	Data any    `json:"data,omitempty"`
}

func main() {
	ctx := context.Background()
	cfg := loadConfig()

	db, err := pgxpool.New(ctx, cfg.databaseURL)
	if err != nil {
		slog.Error("connect postgres", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	if err := retry(ctx, "postgres migration", func(ctx context.Context) error {
		if err := db.Ping(ctx); err != nil {
			return err
		}
		return migrate(ctx, db)
	}); err != nil {
		slog.Error("migrate postgres", "error", err)
		os.Exit(1)
	}

	rdb := redis.NewClient(&redis.Options{Addr: cfg.redisAddr})
	if err := retry(ctx, "redis ping", func(ctx context.Context) error {
		return rdb.Ping(ctx).Err()
	}); err != nil {
		slog.Error("connect redis", "error", err)
		os.Exit(1)
	}
	defer rdb.Close()

	app := &server{
		cfg:   cfg,
		db:    db,
		redis: rdb,
		push:  buildPushDispatcher(cfg),
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				return cfg.corsOrigin == "*" || r.Header.Get("Origin") == cfg.corsOrigin
			},
		},
	}

	router := chi.NewRouter()
	router.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{cfg.corsOrigin},
		AllowedMethods:   []string{"GET", "POST", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	router.Get("/healthz", app.health)
	router.Post("/login", app.login)
	router.Get("/members", app.members)
	router.Post("/devices/register", app.registerDevice)
	router.Delete("/devices/{deviceID}", app.deleteDevice)
	router.Get("/direct/inbox", app.directInbox)
	router.Get("/rooms/{roomID}/messages", app.messages)
	router.Post("/rooms/{roomID}/messages", app.createMessage)
	router.Delete("/rooms/{roomID}/messages", app.deleteMessages)
	router.Post("/calls/token", app.callToken)
	router.Get("/ws", app.websocket)

	slog.Info("starting private chat API", "port", cfg.port)
	if err := http.ListenAndServe(":"+cfg.port, router); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

func loadConfig() config {
	return config{
		port:             env("PORT", "4000"),
		corsOrigin:       env("CORS_ORIGIN", "*"),
		sharedInviteCode: env("SHARED_INVITE_CODE", "home"),
		databaseURL:      env("DATABASE_URL", "postgres://phone_levelg:phone_levelg@localhost:5432/phone_levelg?sslmode=disable"),
		redisAddr:        env("REDIS_ADDR", "localhost:6379"),
		livekitAPIKey:    env("LIVEKIT_API_KEY", "devkey"),
		livekitAPISecret: env("LIVEKIT_API_SECRET", "secret"),
		apnsTeamID:       env("APNS_TEAM_ID", ""),
		apnsKeyID:        env("APNS_KEY_ID", ""),
		apnsBundleID:     env("APNS_BUNDLE_ID", ""),
		apnsPrivateKey:   env("APNS_PRIVATE_KEY", ""),
		apnsEndpoint:     env("APNS_ENDPOINT", "https://api.push.apple.com"),
		fcmProjectID:     env("FCM_PROJECT_ID", ""),
		fcmAccessToken:   env("FCM_ACCESS_TOKEN", ""),
		fcmEndpoint:      env("FCM_ENDPOINT", ""),
	}
}

func env(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func retry(ctx context.Context, name string, operation func(context.Context) error) error {
	var lastErr error
	for attempt := 1; attempt <= 30; attempt++ {
		attemptCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		lastErr = operation(attemptCtx)
		cancel()
		if lastErr == nil {
			return nil
		}

		slog.Warn("dependency not ready", "dependency", name, "attempt", attempt, "error", lastErr)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return lastErr
}

func migrate(ctx context.Context, db *pgxpool.Pool) error {
	_, err := db.Exec(ctx, `
create table if not exists users (
  id text primary key,
  account_email text,
  display_name text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

alter table users add column if not exists account_email text;
alter table users add column if not exists avatar_url text not null default '';
alter table users add column if not exists last_seen_at timestamptz not null default now();
create unique index if not exists users_account_email_lower_idx on users (lower(account_email)) where account_email is not null;

create table if not exists messages (
  id text primary key,
  room_id text not null,
  sender_id text not null references users(id),
  sender_name text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create table if not exists devices (
  device_id text primary key,
  user_id text not null references users(id) on delete cascade,
  platform text not null,
  push_token text not null,
  push_token_type text not null,
  app_version text not null default '',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint devices_platform_check check (platform in ('ios', 'android')),
  constraint devices_push_token_type_check check (push_token_type in ('apns-voip', 'apns', 'fcm', 'expo'))
);
create index if not exists devices_user_id_idx on devices(user_id);
create unique index if not exists devices_platform_push_token_idx on devices(platform, push_token);

create table if not exists call_attempts (
  call_id text primary key,
  room_id text not null,
  sender_id text not null,
  sender_name text not null,
  mode text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint call_attempts_mode_check check (mode in ('voice', 'video'))
);

create table if not exists call_attempt_devices (
  call_id text not null references call_attempts(call_id) on delete cascade,
  device_id text not null,
  recipient_user_id text not null,
  platform text not null,
  push_token_type text not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  primary key (call_id, device_id)
);
create index if not exists call_attempt_devices_recipient_idx on call_attempt_devices(recipient_user_id, created_at desc);

with ranked_users as (
  select id,
         display_name,
         first_value(id) over (
           partition by lower(display_name)
           order by last_seen_at desc, created_at desc, id desc
         ) as keep_id,
         row_number() over (
           partition by lower(display_name)
           order by last_seen_at desc, created_at desc, id desc
         ) as rank
  from users
)
update messages
set sender_id = ranked_users.keep_id
from ranked_users
where messages.sender_id = ranked_users.id
  and ranked_users.rank > 1;

with ranked_users as (
  select id,
         row_number() over (
           partition by lower(display_name)
           order by last_seen_at desc, created_at desc, id desc
         ) as rank
  from users
)
delete from users
where id in (select id from ranked_users where rank > 1);

drop index if exists users_display_name_lower_idx;
create index if not exists messages_room_created_idx on messages(room_id, created_at);
create index if not exists users_last_seen_idx on users(last_seen_at desc);
`)
	return err
}

func (s *server) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	if err := s.db.Ping(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "postgres unavailable"})
		return
	}
	if err := s.redis.Ping(ctx).Err(); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "redis unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) login(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if !readJSON(w, r, &req) {
		return
	}
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	req.AccountEmail = strings.ToLower(strings.TrimSpace(req.AccountEmail))
	req.AvatarURL = normalizeAvatarURL(req.AvatarURL)
	req.InviteCode = strings.TrimSpace(req.InviteCode)
	if req.DisplayName == "" ||
		len(req.DisplayName) > 40 ||
		req.AccountEmail == "" ||
		len(req.AccountEmail) > 254 ||
		!strings.Contains(req.AccountEmail, "@") ||
		req.InviteCode != s.cfg.sharedInviteCode {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid invite"})
		return
	}

	userID := req.AccountEmail
	err := s.db.QueryRow(r.Context(), `
with existing as (
  update users
  set account_email = $1, display_name = $2, avatar_url = $3, last_seen_at = now()
  where lower(account_email) = lower($1)
  returning id
), inserted as (
  insert into users (id, account_email, display_name, avatar_url)
  select $4, $1, $2, $3
  where not exists (select 1 from existing)
  returning id
)
select id from existing
union all
select id from inserted
limit 1`, req.AccountEmail, req.DisplayName, req.AvatarURL, userID).Scan(&userID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "create user failed"})
		return
	}

	writeJSON(w, http.StatusOK, loginResponse{UserID: userID, DisplayName: req.DisplayName, AccountEmail: req.AccountEmail, AvatarURL: req.AvatarURL})
}

func (s *server) members(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(), `
select id, display_name, avatar_url, created_at, last_seen_at
from users
order by last_seen_at desc, created_at desc
limit 100`)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "fetch members failed"})
		return
	}
	defer rows.Close()

	members := make([]member, 0)
	for rows.Next() {
		var item member
		if err := rows.Scan(&item.ID, &item.DisplayName, &item.AvatarURL, &item.CreatedAt, &item.LastSeenAt); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "scan members failed"})
			return
		}
		members = append(members, item)
	}

	writeJSON(w, http.StatusOK, map[string]any{"members": members})
}

func (s *server) registerDevice(w http.ResponseWriter, r *http.Request) {
	var req deviceRegistrationRequest
	if !readJSON(w, r, &req) {
		return
	}
	req.UserID = strings.ToLower(strings.TrimSpace(req.UserID))
	req.DeviceID = strings.TrimSpace(req.DeviceID)
	req.Platform = strings.ToLower(strings.TrimSpace(req.Platform))
	req.PushToken = strings.TrimSpace(req.PushToken)
	req.PushTokenType = strings.ToLower(strings.TrimSpace(req.PushTokenType))
	req.AppVersion = strings.TrimSpace(req.AppVersion)

	if req.UserID == "" || req.DeviceID == "" || req.Platform == "" || req.PushToken == "" || req.PushTokenType == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "user, device, platform, and push token required"})
		return
	}
	if len(req.DeviceID) > 128 || len(req.PushToken) > 4096 || len(req.AppVersion) > 80 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "device registration value too long"})
		return
	}
	if req.Platform != "ios" && req.Platform != "android" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported device platform"})
		return
	}
	if req.PushTokenType != "apns-voip" && req.PushTokenType != "apns" && req.PushTokenType != "fcm" && req.PushTokenType != "expo" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported push token type"})
		return
	}

	var userExists bool
	if err := s.db.QueryRow(r.Context(), `select exists(select 1 from users where id = $1)`, req.UserID).Scan(&userExists); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "check user failed"})
		return
	}
	if !userExists {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "user not found"})
		return
	}
	if _, err := s.db.Exec(r.Context(), `delete from devices where platform = $1 and push_token = $2 and device_id <> $3`, req.Platform, req.PushToken, req.DeviceID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "dedupe device token failed"})
		return
	}

	var response deviceRegistrationResponse
	err := s.db.QueryRow(r.Context(), `
insert into devices (device_id, user_id, platform, push_token, push_token_type, app_version)
values ($1, $2, $3, $4, $5, $6)
on conflict (device_id) do update
set user_id = excluded.user_id,
    platform = excluded.platform,
    push_token = excluded.push_token,
    push_token_type = excluded.push_token_type,
    app_version = excluded.app_version,
    last_seen_at = now()
returning user_id, device_id, platform, push_token_type, app_version, last_seen_at`,
		req.DeviceID, req.UserID, req.Platform, req.PushToken, req.PushTokenType, req.AppVersion,
	).Scan(&response.UserID, &response.DeviceID, &response.Platform, &response.PushTokenType, &response.AppVersion, &response.LastSeenAt)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "register device failed"})
		return
	}

	writeJSON(w, http.StatusOK, response)
}

func (s *server) deleteDevice(w http.ResponseWriter, r *http.Request) {
	deviceID := strings.TrimSpace(chi.URLParam(r, "deviceID"))
	userID := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("userId")))
	if deviceID == "" || userID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "device and user required"})
		return
	}

	tag, err := s.db.Exec(r.Context(), `delete from devices where device_id = $1 and user_id = $2`, deviceID, userID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "delete device failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": tag.RowsAffected()})
}

func (s *server) directInbox(w http.ResponseWriter, r *http.Request) {
	userID := strings.TrimSpace(r.URL.Query().Get("userId"))
	if userID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "user required"})
		return
	}

	rows, err := s.db.Query(r.Context(), `
select distinct on (room_id) id, room_id, sender_id, sender_name, body, created_at
from messages
where room_id like 'dm:%'
  and (room_id like $1 or room_id like $2)
order by room_id, created_at desc`, "dm:"+userID+":%", "dm:%:"+userID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "fetch inbox failed"})
		return
	}
	defer rows.Close()

	inbox := make([]message, 0)
	for rows.Next() {
		var msg message
		if err := rows.Scan(&msg.ID, &msg.RoomID, &msg.SenderID, &msg.Sender, &msg.Text, &msg.CreatedAt); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "scan inbox failed"})
			return
		}
		inbox = append(inbox, msg)
	}

	writeJSON(w, http.StatusOK, map[string]any{"messages": inbox})
}

func (s *server) messages(w http.ResponseWriter, r *http.Request) {
	roomID := strings.TrimSpace(chi.URLParam(r, "roomID"))
	if roomID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "room required"})
		return
	}
	if !canAccessRoom(roomID, strings.TrimSpace(r.URL.Query().Get("userId"))) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "room access denied"})
		return
	}

	rows, err := s.db.Query(r.Context(), `
select id, room_id, sender_id, sender_name, body, created_at
from messages
where room_id = $1
order by created_at desc
limit 200`, roomID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "fetch messages failed"})
		return
	}
	defer rows.Close()

	history := make([]message, 0)
	for rows.Next() {
		var msg message
		if err := rows.Scan(&msg.ID, &msg.RoomID, &msg.SenderID, &msg.Sender, &msg.Text, &msg.CreatedAt); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "scan messages failed"})
			return
		}
		history = append(history, msg)
	}

	for i, j := 0, len(history)-1; i < j; i, j = i+1, j-1 {
		history[i], history[j] = history[j], history[i]
	}

	writeJSON(w, http.StatusOK, map[string]any{"messages": history})
}

func (s *server) createMessage(w http.ResponseWriter, r *http.Request) {
	roomID := strings.TrimSpace(chi.URLParam(r, "roomID"))
	var req createMessageRequest
	if !readJSON(w, r, &req) {
		return
	}
	req.SenderID = strings.TrimSpace(req.SenderID)
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	req.Text = strings.TrimSpace(req.Text)
	if roomID == "" || req.SenderID == "" || req.DisplayName == "" || req.Text == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "room, sender, and text required"})
		return
	}
	if !canAccessRoom(roomID, req.SenderID) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "room access denied"})
		return
	}

	msg, ok := s.storeAndPublishMessage(r.Context(), "room:"+roomID, roomID, req.SenderID, req.DisplayName, req.Text)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "message rejected"})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"message": msg})
}

func (s *server) deleteMessages(w http.ResponseWriter, r *http.Request) {
	roomID := strings.TrimSpace(chi.URLParam(r, "roomID"))
	userID := strings.TrimSpace(r.URL.Query().Get("userId"))
	if roomID == "" || userID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "room and user required"})
		return
	}
	if len(directMessageRecipients(roomID)) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "only direct chats can be deleted"})
		return
	}
	if !canAccessRoom(roomID, userID) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "room access denied"})
		return
	}

	tag, err := s.db.Exec(r.Context(), `delete from messages where room_id = $1`, roomID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "delete messages failed"})
		return
	}

	envelope := outboundEnvelope{Type: "message:clear", Data: map[string]string{"roomId": roomID, "senderId": userID}}
	for _, recipient := range directMessageRecipients(roomID) {
		s.publish(r.Context(), "user:"+recipient, envelope)
	}

	writeJSON(w, http.StatusOK, map[string]any{"deleted": tag.RowsAffected()})
}

func (s *server) callToken(w http.ResponseWriter, r *http.Request) {
	var req callTokenRequest
	if !readJSON(w, r, &req) {
		return
	}
	req.RoomID = strings.TrimSpace(req.RoomID)
	req.Identity = strings.TrimSpace(req.Identity)
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	if req.RoomID == "" || req.Identity == "" || req.DisplayName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "room and identity required"})
		return
	}
	if !canAccessRoom(req.RoomID, req.Identity) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "room access denied"})
		return
	}

	token := auth.NewAccessToken(s.cfg.livekitAPIKey, s.cfg.livekitAPISecret)
	token.SetIdentity(req.Identity).
		SetName(req.DisplayName).
		SetValidFor(time.Hour).
		SetVideoGrant(&auth.VideoGrant{
			RoomJoin:     true,
			Room:         req.RoomID,
			CanPublish:   boolPtr(true),
			CanSubscribe: boolPtr(true),
		})

	jwt, err := token.ToJWT()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "token failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": jwt})
}

func (s *server) websocket(w http.ResponseWriter, r *http.Request) {
	roomID := strings.TrimSpace(r.URL.Query().Get("roomId"))
	userID := strings.TrimSpace(r.URL.Query().Get("userId"))
	displayName := strings.TrimSpace(r.URL.Query().Get("displayName"))
	if roomID == "" || userID == "" || displayName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "room, user, and displayName required"})
		return
	}
	if !canAccessRoom(roomID, userID) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "room access denied"})
		return
	}

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	channel := "room:" + roomID
	userChannel := "user:" + userID
	pubsub := s.redis.Subscribe(ctx, channel, userChannel)
	defer pubsub.Close()

	go func() {
		for msg := range pubsub.Channel() {
			var envelope outboundEnvelope
			if err := json.Unmarshal([]byte(msg.Payload), &envelope); err == nil {
				_ = conn.WriteJSON(envelope)
			}
		}
	}()

	joinedMember := member{
		ID:          userID,
		DisplayName: displayName,
		LastSeenAt:  time.Now().UTC(),
	}
	s.publish(ctx, channel, outboundEnvelope{Type: "member:joined", Data: joinedMember})

	for {
		var envelope wsEnvelope
		if err := conn.ReadJSON(&envelope); err != nil {
			return
		}

		switch envelope.Type {
		case "message:send":
			var body struct {
				Text string `json:"text"`
			}
			if err := json.Unmarshal(envelope.Data, &body); err != nil {
				continue
			}
			s.storeAndPublishMessage(ctx, channel, roomID, userID, displayName, body.Text)
		case "call:ring":
			var body struct {
				RoomID string `json:"roomId"`
				Mode   string `json:"mode"`
			}
			_ = json.Unmarshal(envelope.Data, &body)
			targetRoomID := strings.TrimSpace(body.RoomID)
			if targetRoomID == "" {
				targetRoomID = roomID
			}
			if !canAccessRoom(targetRoomID, userID) {
				continue
			}
			if body.Mode != "video" {
				body.Mode = "voice"
			}
			payload := callPushPayload{
				CallID:    randomID(),
				RoomID:    targetRoomID,
				SenderID:  userID,
				Sender:    displayName,
				Mode:      body.Mode,
				ExpiresAt: time.Now().UTC().Add(45 * time.Second),
			}
			envelope := outboundEnvelope{
				Type: "call:ring",
				Data: payload,
			}
			s.publishCallEvent(ctx, targetRoomID, userID, envelope)
			s.dispatchNativeCallPush(ctx, targetRoomID, userID, payload)
		case "call:end":
			var body struct {
				RoomID string `json:"roomId"`
			}
			_ = json.Unmarshal(envelope.Data, &body)
			targetRoomID := strings.TrimSpace(body.RoomID)
			if targetRoomID == "" {
				targetRoomID = roomID
			}
			if !canAccessRoom(targetRoomID, userID) {
				continue
			}
			envelope := outboundEnvelope{
				Type: "call:end",
				Data: map[string]string{
					"roomId":   targetRoomID,
					"senderId": userID,
					"sender":   displayName,
				},
			}
			s.publishCallEvent(ctx, targetRoomID, userID, envelope)
		case "call:reject":
			var body struct {
				RoomID string `json:"roomId"`
			}
			_ = json.Unmarshal(envelope.Data, &body)
			targetRoomID := strings.TrimSpace(body.RoomID)
			if targetRoomID == "" {
				targetRoomID = roomID
			}
			if !canAccessRoom(targetRoomID, userID) {
				continue
			}
			envelope := outboundEnvelope{
				Type: "call:reject",
				Data: map[string]string{
					"roomId":   targetRoomID,
					"senderId": userID,
					"sender":   displayName,
				},
			}
			s.publishCallEvent(ctx, targetRoomID, userID, envelope)
		}
	}
}

func (s *server) publishCallEvent(ctx context.Context, roomID, senderID string, envelope outboundEnvelope) {
	for _, recipient := range s.callRecipients(ctx, roomID, senderID) {
		s.publish(ctx, "user:"+recipient, envelope)
	}
}

func (s *server) dispatchNativeCallPush(ctx context.Context, roomID, senderID string, payload callPushPayload) {
	dispatcher := s.push
	if dispatcher == nil {
		dispatcher = noopPushDispatcher{}
	}
	recipients := s.callRecipients(ctx, roomID, senderID)
	devices := s.pushDevicesForRecipients(ctx, recipients)
	s.storeCallAttempt(ctx, payload, devices)
	if len(devices) == 0 {
		return
	}
	if err := dispatcher.DispatchCallPush(ctx, payload, devices); err != nil {
		slog.Error("dispatch call push", "error", err)
	}
}

func (s *server) callRecipients(ctx context.Context, roomID, senderID string) []string {
	if recipients := directMessageRecipients(roomID); len(recipients) > 0 {
		filtered := make([]string, 0, len(recipients))
		for _, recipient := range recipients {
			if recipient != senderID {
				filtered = append(filtered, recipient)
			}
		}
		return filtered
	}

	rows, err := s.db.Query(ctx, `select id from users where id <> $1`, senderID)
	if err != nil {
		return nil
	}
	defer rows.Close()

	recipients := make([]string, 0)
	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err == nil {
			recipients = append(recipients, userID)
		}
	}
	return recipients
}

func (s *server) pushDevicesForRecipients(ctx context.Context, recipients []string) []pushDevice {
	if len(recipients) == 0 {
		return nil
	}

	rows, err := s.db.Query(ctx, `
select device_id, user_id, platform, push_token, push_token_type
from devices
where user_id = any($1)
order by user_id, device_id`, recipients)
	if err != nil {
		slog.Error("load push devices", "error", err)
		return nil
	}
	defer rows.Close()

	devices := make([]pushDevice, 0)
	for rows.Next() {
		var device pushDevice
		if err := rows.Scan(&device.DeviceID, &device.UserID, &device.Platform, &device.PushToken, &device.PushTokenType); err == nil {
			devices = append(devices, device)
		}
	}
	return devices
}

func (s *server) storeCallAttempt(ctx context.Context, payload callPushPayload, devices []pushDevice) {
	if s.db == nil {
		return
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		slog.Error("begin call attempt", "error", err)
		return
	}
	defer tx.Rollback(ctx)

	_, err = tx.Exec(ctx, `
insert into call_attempts (call_id, room_id, sender_id, sender_name, mode, expires_at)
values ($1, $2, $3, $4, $5, $6)
on conflict (call_id) do nothing`,
		payload.CallID, payload.RoomID, payload.SenderID, payload.Sender, payload.Mode, payload.ExpiresAt)
	if err != nil {
		slog.Error("store call attempt", "error", err)
		return
	}

	for _, device := range devices {
		_, err = tx.Exec(ctx, `
insert into call_attempt_devices (call_id, device_id, recipient_user_id, platform, push_token_type)
values ($1, $2, $3, $4, $5)
on conflict (call_id, device_id) do nothing`,
			payload.CallID, device.DeviceID, device.UserID, device.Platform, device.PushTokenType)
		if err != nil {
			slog.Error("store call attempt device", "error", err)
			return
		}
	}

	if err := tx.Commit(ctx); err != nil {
		slog.Error("commit call attempt", "error", err)
	}
}

func (s *server) storeAndPublishMessage(ctx context.Context, channel, roomID, senderID, sender, text string) (message, bool) {
	text = strings.TrimSpace(text)
	if text == "" || len(text) > 2000 {
		return message{}, false
	}

	msg := message{
		ID:        randomID(),
		RoomID:    roomID,
		SenderID:  senderID,
		Sender:    sender,
		Text:      text,
		CreatedAt: time.Now().UTC(),
	}

	_, err := s.db.Exec(ctx, `
insert into messages (id, room_id, sender_id, sender_name, body, created_at)
values ($1, $2, $3, $4, $5, $6)`,
		msg.ID, msg.RoomID, msg.SenderID, msg.Sender, msg.Text, msg.CreatedAt)
	if err != nil {
		slog.Error("store message", "error", err)
		return message{}, false
	}

	envelope := outboundEnvelope{Type: "message:new", Data: msg}
	s.publish(ctx, channel, envelope)
	for _, recipient := range directMessageRecipients(roomID) {
		if recipient != senderID {
			s.publish(ctx, "user:"+recipient, envelope)
		}
	}
	return msg, true
}

func apnsCallPayload(payload callPushPayload) map[string]any {
	return map[string]any{
		"aps": map[string]any{
			"alert": map[string]string{
				"title": callPushTitle(payload.Mode),
				"body":  payload.Sender + " is calling",
			},
			"sound":             "rockstar.mp3",
			"category":          "INCOMING_CALL",
			"content-available": 1,
		},
		"callId":    payload.CallID,
		"roomId":    payload.RoomID,
		"senderId":  payload.SenderID,
		"sender":    payload.Sender,
		"mode":      payload.Mode,
		"expiresAt": payload.ExpiresAt.Format(time.RFC3339Nano),
	}
}

func fcmCallPayload(payload callPushPayload, token string) map[string]any {
	data := map[string]string{
		"type":      "call:ring",
		"callId":    payload.CallID,
		"roomId":    payload.RoomID,
		"senderId":  payload.SenderID,
		"sender":    payload.Sender,
		"mode":      payload.Mode,
		"expiresAt": payload.ExpiresAt.Format(time.RFC3339Nano),
	}
	return map[string]any{
		"message": map[string]any{
			"token": token,
			"data":  data,
			"android": map[string]any{
				"priority": "HIGH",
			},
			"notification": map[string]string{
				"title": callPushTitle(payload.Mode),
				"body":  payload.Sender + " is calling",
			},
		},
	}
}

func callPushTitle(mode string) string {
	if mode == "video" {
		return "Incoming video call"
	}
	return "Incoming voice call"
}

func parseAPNSPrivateKey(value string) (*ecdsa.PrivateKey, error) {
	normalized := strings.ReplaceAll(strings.TrimSpace(value), `\n`, "\n")
	block, _ := pem.Decode([]byte(normalized))
	if block == nil {
		return nil, errors.New("missing pem block")
	}
	parsedKey, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	key, ok := parsedKey.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errors.New("apns private key must be ecdsa")
	}
	return key, nil
}

func jwtUnsigned(header, claims any) (string, error) {
	headerJSON, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	claimsJSON, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(headerJSON) + "." + base64.RawURLEncoding.EncodeToString(claimsJSON), nil
}

func fixedECDSASignature(r, s *big.Int, size int) []byte {
	signature := make([]byte, size*2)
	r.FillBytes(signature[:size])
	s.FillBytes(signature[size:])
	return signature
}

func directMessageRecipients(roomID string) []string {
	parts := strings.Split(roomID, ":")
	if len(parts) == 3 && parts[0] == "dm" && parts[1] != "" && parts[2] != "" {
		return parts[1:]
	}
	return nil
}

func canAccessRoom(roomID, userID string) bool {
	recipients := directMessageRecipients(roomID)
	if len(recipients) == 0 {
		return true
	}
	for _, recipient := range recipients {
		if recipient == userID {
			return true
		}
	}
	return false
}

func normalizeAvatarURL(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 512 {
		return ""
	}
	if strings.HasPrefix(value, "https://") {
		return value
	}
	return ""
}

func (s *server) publish(ctx context.Context, channel string, envelope outboundEnvelope) {
	payload, err := json.Marshal(envelope)
	if err != nil {
		return
	}
	if err := s.redis.Publish(ctx, channel, payload).Err(); err != nil {
		slog.Error("publish websocket event", "error", err)
	}
}

func readJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	defer r.Body.Close()
	if err := json.NewDecoder(r.Body).Decode(target); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func randomID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return hex.EncodeToString([]byte(time.Now().Format(time.RFC3339Nano)))
	}
	return hex.EncodeToString(bytes[:])
}

func boolPtr(value bool) *bool {
	return &value
}
