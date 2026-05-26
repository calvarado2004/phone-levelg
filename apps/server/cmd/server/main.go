package main

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/livekit/protocol/auth"
	"github.com/redis/go-redis/v9"
)

type config struct {
	port              string
	corsOrigin        string
	sharedInviteCode  string
	databaseURL       string
	redisAddr         string
	livekitAPIKey     string
	livekitAPISecret  string
	apnsTeamID        string
	apnsKeyID         string
	apnsBundleID      string
	apnsPrivateKey    string
	apnsEndpoint      string
	fcmProjectID      string
	fcmAccessToken    string
	fcmServiceAccount string
	fcmEndpoint       string
	googleUserInfoURL string
}

const maxMessageBodyBytes = 6000
const maxAttachmentBodyBytes = 12 * 1024 * 1024
const pushQueueCapacity = 4096
const pushWorkerCount = 16
const apnsMaxSendAttempts = 6
const apnsRetryBaseDelay = 2 * time.Second

type server struct {
	cfg       config
	db        *pgxpool.Pool
	redis     *redis.Client
	upgrader  websocket.Upgrader
	push      pushDispatcher
	pushQueue chan pushJob
}

type pushJob func(context.Context)

type loginRequest struct {
	DisplayName       string `json:"displayName"`
	AccountEmail      string `json:"accountEmail"`
	AvatarURL         string `json:"avatarURL"`
	GoogleAccessToken string `json:"googleAccessToken"`
	InviteCode        string `json:"inviteCode"`
}

type loginResponse struct {
	UserID           string `json:"userId"`
	DisplayName      string `json:"displayName"`
	AccountEmail     string `json:"accountEmail"`
	AvatarURL        string `json:"avatarURL,omitempty"`
	MessageKeySecret string `json:"messageKeySecret"`
}

type googleUserInfo struct {
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Name          string `json:"name"`
	Picture       string `json:"picture"`
}

type member struct {
	ID              string    `json:"id"`
	DisplayName     string    `json:"displayName"`
	AvatarURL       string    `json:"avatarURL,omitempty"`
	CreatedAt       time.Time `json:"createdAt"`
	LastSeenAt      time.Time `json:"lastSeenAt"`
	LastReachableAt time.Time `json:"lastReachableAt"`
	Reachable       bool      `json:"reachable"`
}

type message struct {
	ID          string     `json:"id"`
	RoomID      string     `json:"roomId"`
	SenderID    string     `json:"senderId"`
	Sender      string     `json:"sender"`
	Text        string     `json:"text"`
	CreatedAt   time.Time  `json:"createdAt"`
	DeliveredAt *time.Time `json:"deliveredAt,omitempty"`
	ReadAt      *time.Time `json:"readAt,omitempty"`
}

type attachment struct {
	ID        string    `json:"id"`
	RoomID    string    `json:"roomId"`
	SenderID  string    `json:"senderId"`
	Data      string    `json:"data,omitempty"`
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

type messagePushPayload struct {
	MessageID string
	RoomID    string
	SenderID  string
	Sender    string
	Preview   string
}

type pushDispatcher interface {
	DispatchCallPush(context.Context, callPushPayload, []pushDevice) error
	DispatchMessagePush(context.Context, messagePushPayload, []pushDevice) error
}

type noopPushDispatcher struct{}

func (noopPushDispatcher) DispatchCallPush(context.Context, callPushPayload, []pushDevice) error {
	return nil
}

func (noopPushDispatcher) DispatchMessagePush(context.Context, messagePushPayload, []pushDevice) error {
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
		case "apns-voip":
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
		case "apns":
			// iOS calls must arrive through PushKit/CallKit only; regular APNs alerts are for messages.
			continue
		default:
			slog.Info("skip unsupported push token type", "deviceID", device.DeviceID, "pushTokenType", device.PushTokenType)
		}
	}
	return lastErr
}

func (d compositePushDispatcher) DispatchMessagePush(ctx context.Context, payload messagePushPayload, devices []pushDevice) error {
	var lastErr error
	for _, device := range devices {
		switch device.PushTokenType {
		case "apns":
			if d.apns == nil {
				slog.Info("skip apns message push; provider disabled", "deviceID", device.DeviceID, "userID", device.UserID)
				continue
			}
			if err := d.apns.SendMessagePush(ctx, payload, device); err != nil {
				lastErr = err
				slog.Error("send apns message push", "deviceID", device.DeviceID, "userID", device.UserID, "error", err)
			}
		case "fcm":
			if d.fcm == nil {
				slog.Info("skip fcm message push; provider disabled", "deviceID", device.DeviceID, "userID", device.UserID)
				continue
			}
			if err := d.fcm.SendMessagePush(ctx, payload, device); err != nil {
				lastErr = err
				slog.Error("send fcm message push", "deviceID", device.DeviceID, "userID", device.UserID, "error", err)
			}
		case "apns-voip":
			// VoIP pushes are reserved for real incoming calls so iOS can reliably report through CallKit.
			continue
		default:
			slog.Info("skip unsupported message push token type", "deviceID", device.DeviceID, "pushTokenType", device.PushTokenType)
		}
	}
	return lastErr
}

type apnsProvider struct {
	teamID         string
	keyID          string
	bundleID       string
	privateKey     *ecdsa.PrivateKey
	endpoint       string
	client         *http.Client
	tokenMu        sync.Mutex
	token          string
	tokenExpiresAt time.Time
}

func newAPNSProvider(cfg config) *apnsProvider {
	missing := missingAPNSConfig(cfg)
	if len(missing) > 0 {
		slog.Error("disable apns provider; missing config", "missing", strings.Join(missing, ","))
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

func missingAPNSConfig(cfg config) []string {
	var missing []string
	if cfg.apnsTeamID == "" {
		missing = append(missing, "APNS_TEAM_ID")
	}
	if cfg.apnsKeyID == "" {
		missing = append(missing, "APNS_KEY_ID")
	}
	if cfg.apnsBundleID == "" {
		missing = append(missing, "APNS_BUNDLE_ID")
	}
	if cfg.apnsPrivateKey == "" {
		missing = append(missing, "APNS_PRIVATE_KEY")
	}
	return missing
}

func (p *apnsProvider) SendCallPush(ctx context.Context, payload callPushPayload, device pushDevice) error {
	body, err := json.Marshal(apnsCallPayload(payload))
	if err != nil {
		return err
	}
	pushType := "alert"
	topic := p.bundleID
	if device.PushTokenType == "apns-voip" {
		pushType = "voip"
		topic += ".voip"
	}
	return p.sendPush(ctx, device.PushToken, topic, pushType, body)
}

func (p *apnsProvider) SendMessagePush(ctx context.Context, payload messagePushPayload, device pushDevice) error {
	body, err := json.Marshal(apnsMessagePayload(payload))
	if err != nil {
		return err
	}
	return p.sendPush(ctx, device.PushToken, p.bundleID, "alert", body)
}

func (p *apnsProvider) sendPush(ctx context.Context, token, topic, pushType string, body []byte) error {
	var lastErr error
	for attempt := 1; attempt <= apnsMaxSendAttempts; attempt++ {
		err := p.sendPushOnce(ctx, token, topic, pushType, body)
		if err == nil {
			return nil
		}
		lastErr = err
		if !isRetryableAPNSError(err) || attempt == apnsMaxSendAttempts {
			return err
		}
		delay := apnsRetryBaseDelay * time.Duration(attempt)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
	}
	return lastErr
}

func (p *apnsProvider) sendPushOnce(ctx context.Context, token, topic, pushType string, body []byte) error {
	authToken, err := p.authorizationToken(time.Now())
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint+"/3/device/"+token, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("authorization", "bearer "+authToken)
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
		return apnsResponseError(resp)
	}
	return nil
}

type apnsStatusError struct {
	statusCode int
	status     string
	detail     string
}

func (e apnsStatusError) Error() string {
	if e.detail == "" {
		return fmt.Sprintf("apns returned %s", e.status)
	}
	return fmt.Sprintf("apns returned %s: %s", e.status, e.detail)
}

func apnsResponseError(resp *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	detail := strings.TrimSpace(string(body))
	return apnsStatusError{statusCode: resp.StatusCode, status: resp.Status, detail: detail}
}

func isRetryableAPNSError(err error) bool {
	var statusErr apnsStatusError
	if errors.As(err, &statusErr) {
		return statusErr.statusCode == http.StatusTooManyRequests || statusErr.statusCode >= 500
	}
	return false
}

func (p *apnsProvider) authorizationToken(now time.Time) (string, error) {
	p.tokenMu.Lock()
	defer p.tokenMu.Unlock()
	if p.token != "" && now.Before(p.tokenExpiresAt) {
		return p.token, nil
	}

	token, err := p.signedAuthorizationToken(now)
	if err != nil {
		return "", err
	}
	p.token = token
	p.tokenExpiresAt = now.Add(50 * time.Minute)
	return token, nil
}

func (p *apnsProvider) signedAuthorizationToken(now time.Time) (string, error) {
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
	projectID      string
	accessToken    string
	serviceAccount *googleServiceAccount
	endpoint       string
	client         *http.Client
	tokenMu        sync.Mutex
	token          string
	tokenExpiresAt time.Time
}

func newFCMProvider(cfg config) *fcmProvider {
	serviceAccount, err := parseGoogleServiceAccount(cfg.fcmServiceAccount)
	if err != nil {
		slog.Error("disable fcm provider; invalid service account", "error", err)
		return nil
	}
	projectID := strings.TrimSpace(cfg.fcmProjectID)
	if projectID == "" && serviceAccount != nil {
		projectID = serviceAccount.ProjectID
	}
	if projectID == "" || (cfg.fcmAccessToken == "" && serviceAccount == nil) {
		return nil
	}
	endpoint := strings.TrimSpace(cfg.fcmEndpoint)
	if endpoint == "" {
		endpoint = "https://fcm.googleapis.com/v1/projects/" + projectID + "/messages:send"
	}
	return &fcmProvider{
		projectID:      projectID,
		accessToken:    cfg.fcmAccessToken,
		serviceAccount: serviceAccount,
		endpoint:       endpoint,
		client:         &http.Client{Timeout: 10 * time.Second},
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
	accessToken, err := p.bearerToken(ctx)
	if err != nil {
		return err
	}
	req.Header.Set("authorization", "Bearer "+accessToken)
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

func (p *fcmProvider) SendMessagePush(ctx context.Context, payload messagePushPayload, device pushDevice) error {
	body, err := json.Marshal(fcmMessagePayload(payload, device.PushToken))
	if err != nil {
		return err
	}
	return p.sendPush(ctx, body)
}

func (p *fcmProvider) sendPush(ctx context.Context, body []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	accessToken, err := p.bearerToken(ctx)
	if err != nil {
		return err
	}
	req.Header.Set("authorization", "Bearer "+accessToken)
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

func (p *fcmProvider) bearerToken(ctx context.Context) (string, error) {
	if p.accessToken != "" {
		return p.accessToken, nil
	}
	p.tokenMu.Lock()
	defer p.tokenMu.Unlock()
	if p.token != "" && time.Until(p.tokenExpiresAt) > time.Minute {
		return p.token, nil
	}
	if p.serviceAccount == nil {
		return "", errors.New("missing fcm credentials")
	}
	token, expiresAt, err := p.serviceAccount.accessToken(ctx, p.client)
	if err != nil {
		return "", err
	}
	p.token = token
	p.tokenExpiresAt = expiresAt
	return token, nil
}

type googleServiceAccount struct {
	ProjectID   string `json:"project_id"`
	ClientEmail string `json:"client_email"`
	PrivateKey  string `json:"private_key"`
	TokenURI    string `json:"token_uri"`
	privateKey  *rsa.PrivateKey
}

func parseGoogleServiceAccount(value string) (*googleServiceAccount, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	var account googleServiceAccount
	if err := json.Unmarshal([]byte(value), &account); err != nil {
		return nil, err
	}
	account.ProjectID = strings.TrimSpace(account.ProjectID)
	account.ClientEmail = strings.TrimSpace(account.ClientEmail)
	account.PrivateKey = strings.ReplaceAll(strings.TrimSpace(account.PrivateKey), `\n`, "\n")
	account.TokenURI = strings.TrimSpace(account.TokenURI)
	if account.TokenURI == "" {
		account.TokenURI = "https://oauth2.googleapis.com/token"
	}
	if account.ProjectID == "" || account.ClientEmail == "" || account.PrivateKey == "" {
		return nil, errors.New("project_id, client_email, and private_key are required")
	}
	key, err := parseRSAPrivateKey(account.PrivateKey)
	if err != nil {
		return nil, err
	}
	account.privateKey = key
	return &account, nil
}

func parseRSAPrivateKey(value string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(value))
	if block == nil {
		return nil, errors.New("missing pem block")
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	parsedKey, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	key, ok := parsedKey.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("service account private key must be rsa")
	}
	return key, nil
}

func (a *googleServiceAccount) accessToken(ctx context.Context, client *http.Client) (string, time.Time, error) {
	now := time.Now()
	assertion, err := a.jwtAssertion(now)
	if err != nil {
		return "", time.Time{}, err
	}
	body := strings.NewReader("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + assertion)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.TokenURI, body)
	if err != nil {
		return "", time.Time{}, err
	}
	req.Header.Set("content-type", "application/x-www-form-urlencoded")
	resp, err := client.Do(req)
	if err != nil {
		return "", time.Time{}, err
	}
	defer resp.Body.Close()
	var tokenResponse struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
		Error       string `json:"error"`
		Description string `json:"error_description"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tokenResponse); err != nil {
		return "", time.Time{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if tokenResponse.Description != "" {
			return "", time.Time{}, fmt.Errorf("google oauth returned %s: %s", resp.Status, tokenResponse.Description)
		}
		return "", time.Time{}, fmt.Errorf("google oauth returned %s", resp.Status)
	}
	if tokenResponse.AccessToken == "" {
		return "", time.Time{}, errors.New("google oauth returned empty access token")
	}
	expiresIn := tokenResponse.ExpiresIn
	if expiresIn <= 0 {
		expiresIn = 3600
	}
	return tokenResponse.AccessToken, now.Add(time.Duration(expiresIn) * time.Second), nil
}

func (a *googleServiceAccount) jwtAssertion(now time.Time) (string, error) {
	header, err := json.Marshal(map[string]string{"alg": "RS256", "typ": "JWT"})
	if err != nil {
		return "", err
	}
	claims, err := json.Marshal(map[string]any{
		"iss":   a.ClientEmail,
		"scope": "https://www.googleapis.com/auth/firebase.messaging",
		"aud":   a.TokenURI,
		"iat":   now.Unix(),
		"exp":   now.Add(time.Hour).Unix(),
	})
	if err != nil {
		return "", err
	}
	unsigned := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(claims)
	digest := sha256.Sum256([]byte(unsigned))
	signature, err := rsa.SignPKCS1v15(rand.Reader, a.privateKey, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(signature), nil
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

type messageReceiptRequest struct {
	UserID            string   `json:"userId"`
	MessageIDs        []string `json:"messageIds"`
	LastReadMessageID string   `json:"lastReadMessageId"`
}

type createAttachmentRequest struct {
	SenderID string `json:"senderId"`
	Data     string `json:"data"`
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
		cfg:       cfg,
		db:        db,
		redis:     rdb,
		push:      buildPushDispatcher(cfg),
		pushQueue: make(chan pushJob, pushQueueCapacity),
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				return cfg.corsOrigin == "*" || r.Header.Get("Origin") == cfg.corsOrigin
			},
		},
	}
	app.startPushWorkers(ctx)

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
	router.Post("/rooms/{roomID}/messages/delivered", app.deliverMessages)
	router.Post("/rooms/{roomID}/messages/read", app.readMessages)
	router.Delete("/rooms/{roomID}/messages", app.deleteMessages)
	router.Post("/rooms/{roomID}/attachments", app.createAttachment)
	router.Get("/rooms/{roomID}/attachments/{attachmentID}", app.getAttachment)
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
		port:              env("PORT", "4000"),
		corsOrigin:        env("CORS_ORIGIN", "*"),
		sharedInviteCode:  env("SHARED_INVITE_CODE", "home"),
		databaseURL:       env("DATABASE_URL", "postgres://phone_levelg:phone_levelg@localhost:5432/phone_levelg?sslmode=disable"),
		redisAddr:         env("REDIS_ADDR", "localhost:6379"),
		livekitAPIKey:     env("LIVEKIT_API_KEY", "devkey"),
		livekitAPISecret:  env("LIVEKIT_API_SECRET", "secret"),
		apnsTeamID:        env("APNS_TEAM_ID", ""),
		apnsKeyID:         env("APNS_KEY_ID", ""),
		apnsBundleID:      env("APNS_BUNDLE_ID", ""),
		apnsPrivateKey:    env("APNS_PRIVATE_KEY", ""),
		apnsEndpoint:      env("APNS_ENDPOINT", "https://api.push.apple.com"),
		fcmProjectID:      env("FCM_PROJECT_ID", ""),
		fcmAccessToken:    env("FCM_ACCESS_TOKEN", ""),
		fcmServiceAccount: env("FCM_SERVICE_ACCOUNT_JSON", ""),
		fcmEndpoint:       env("FCM_ENDPOINT", ""),
		googleUserInfoURL: env("GOOGLE_USERINFO_URL", "https://www.googleapis.com/oauth2/v3/userinfo"),
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

create table if not exists message_receipts (
  message_id text not null references messages(id) on delete cascade,
  room_id text not null,
  user_id text not null references users(id) on delete cascade,
  delivered_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
create index if not exists message_receipts_user_unread_idx on message_receipts(user_id, created_at desc) where read_at is null;
create index if not exists message_receipts_room_user_idx on message_receipts(room_id, user_id);

create table if not exists attachments (
  id text primary key,
  room_id text not null,
  sender_id text not null references users(id),
  body bytea not null,
  created_at timestamptz not null default now()
);
create index if not exists attachments_room_created_idx on attachments(room_id, created_at);

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

create table if not exists message_delivery_attempts (
  message_id text not null references messages(id) on delete cascade,
  device_id text not null references devices(device_id) on delete cascade,
  recipient_user_id text not null references users(id) on delete cascade,
  platform text not null,
  push_token_type text not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (message_id, device_id),
  constraint message_delivery_attempts_status_check check (status in ('pending', 'sent', 'delivered', 'failed', 'expired'))
);
create index if not exists message_delivery_attempts_pending_idx on message_delivery_attempts(message_id, status);
create index if not exists message_delivery_attempts_recipient_idx on message_delivery_attempts(recipient_user_id, created_at desc);

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
	req.GoogleAccessToken = strings.TrimSpace(req.GoogleAccessToken)
	req.InviteCode = strings.TrimSpace(req.InviteCode)

	if req.GoogleAccessToken != "" {
		profile, err := s.googleUserInfo(r.Context(), req.GoogleAccessToken)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "google identity rejected"})
			return
		}
		req.AccountEmail = strings.ToLower(strings.TrimSpace(profile.Email))
		req.DisplayName = strings.TrimSpace(profile.Name)
		req.AvatarURL = normalizeAvatarURL(profile.Picture)
		if req.DisplayName == "" && req.AccountEmail != "" {
			req.DisplayName = strings.Split(req.AccountEmail, "@")[0]
		}
	}

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
insert into users (id, account_email, display_name, avatar_url)
values ($1, $1, $2, $3)
on conflict (id) do update
set account_email = excluded.account_email,
    display_name = excluded.display_name,
    avatar_url = excluded.avatar_url,
    last_seen_at = now()
returning id`, userID, req.DisplayName, req.AvatarURL).Scan(&userID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "create user failed"})
		return
	}

	writeJSON(w, http.StatusOK, loginResponse{
		UserID:           userID,
		DisplayName:      req.DisplayName,
		AccountEmail:     req.AccountEmail,
		AvatarURL:        req.AvatarURL,
		MessageKeySecret: messageKeySecret(s.cfg.sharedInviteCode),
	})
}

func messageKeySecret(inviteCode string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(inviteCode)))
	return hex.EncodeToString(sum[:])
}

func (s *server) googleUserInfo(ctx context.Context, accessToken string) (googleUserInfo, error) {
	if accessToken == "" {
		return googleUserInfo{}, errors.New("missing google access token")
	}
	endpoint := strings.TrimSpace(s.cfg.googleUserInfoURL)
	if endpoint == "" {
		endpoint = "https://www.googleapis.com/oauth2/v3/userinfo"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return googleUserInfo{}, err
	}
	req.Header.Set("authorization", "Bearer "+accessToken)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return googleUserInfo{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return googleUserInfo{}, fmt.Errorf("google userinfo returned %s", resp.Status)
	}
	var profile googleUserInfo
	if err := json.NewDecoder(resp.Body).Decode(&profile); err != nil {
		return googleUserInfo{}, err
	}
	profile.Email = strings.ToLower(strings.TrimSpace(profile.Email))
	profile.Name = strings.TrimSpace(profile.Name)
	profile.Picture = normalizeAvatarURL(profile.Picture)
	if profile.Email == "" || !strings.Contains(profile.Email, "@") || !profile.EmailVerified {
		return googleUserInfo{}, errors.New("google account email is not verified")
	}
	return profile, nil
}

func (s *server) members(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(), `
select u.id,
       u.display_name,
       u.avatar_url,
       u.created_at,
       u.last_seen_at,
       greatest(u.last_seen_at, coalesce(max(d.last_seen_at), u.last_seen_at)) as last_reachable_at,
       greatest(u.last_seen_at, coalesce(max(d.last_seen_at), u.last_seen_at)) > now() - interval '30 days' as reachable
from users u
left join devices d on d.user_id = u.id
group by u.id, u.display_name, u.avatar_url, u.created_at, u.last_seen_at
order by last_reachable_at desc, u.created_at desc
limit 100`)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "fetch members failed"})
		return
	}
	defer rows.Close()

	members := make([]member, 0)
	for rows.Next() {
		var item member
		if err := rows.Scan(&item.ID, &item.DisplayName, &item.AvatarURL, &item.CreatedAt, &item.LastSeenAt, &item.LastReachableAt, &item.Reachable); err != nil {
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
	if _, err := s.db.Exec(r.Context(), `update users set last_seen_at = now() where id = $1`, req.UserID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "refresh user reachability failed"})
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
	if err := s.pruneUserDevices(r.Context(), req.UserID, 3); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "prune device sessions failed"})
		return
	}

	writeJSON(w, http.StatusOK, response)
}

func (s *server) pruneUserDevices(ctx context.Context, userID string, maxPhysicalDevices int) error {
	if maxPhysicalDevices <= 0 {
		return nil
	}
	_, err := s.db.Exec(ctx, `
with ranked as (
  select regexp_replace(device_id, ':voip$', '') as physical_device_id,
         max(last_seen_at) as last_seen_at
  from devices
  where user_id = $1
  group by regexp_replace(device_id, ':voip$', '')
), kept as (
  select physical_device_id
  from ranked
  order by last_seen_at desc, physical_device_id desc
  limit $2
)
delete from devices
where user_id = $1
  and regexp_replace(device_id, ':voip$', '') not in (select physical_device_id from kept)`, userID, maxPhysicalDevices)
	return err
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
select distinct on (m.room_id) m.id, m.room_id, m.sender_id, m.sender_name, m.body, m.created_at
from messages m
join message_receipts mr on mr.message_id = m.id
where mr.user_id = $1
  and mr.read_at is null
  and m.room_id like 'dm:%'
order by m.room_id, m.created_at desc`, userID)
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
	roomID := roomIDParam(r)
	userID := strings.TrimSpace(r.URL.Query().Get("userId"))
	if roomID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "room required"})
		return
	}
	if !canAccessRoom(roomID, userID) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "room access denied"})
		return
	}

	rows, err := s.db.Query(r.Context(), `
select m.id, m.room_id, m.sender_id, m.sender_name, m.body, m.created_at, mr.delivered_at, mr.read_at
from messages m
left join message_receipts mr on mr.message_id = m.id
  and m.sender_id = $2
  and mr.user_id <> $2
where m.room_id = $1
order by m.created_at desc
limit 200`, roomID, userID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "fetch messages failed"})
		return
	}
	defer rows.Close()

	history := make([]message, 0)
	for rows.Next() {
		var msg message
		var deliveredAt sql.NullTime
		var readAt sql.NullTime
		if err := rows.Scan(&msg.ID, &msg.RoomID, &msg.SenderID, &msg.Sender, &msg.Text, &msg.CreatedAt, &deliveredAt, &readAt); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "scan messages failed"})
			return
		}
		if deliveredAt.Valid {
			deliveredAtTime := deliveredAt.Time
			msg.DeliveredAt = &deliveredAtTime
		}
		if readAt.Valid {
			readAtTime := readAt.Time
			msg.ReadAt = &readAtTime
		}
		history = append(history, msg)
	}

	for i, j := 0, len(history)-1; i < j; i, j = i+1, j-1 {
		history[i], history[j] = history[j], history[i]
	}

	writeJSON(w, http.StatusOK, map[string]any{"messages": history})
}

func (s *server) createMessage(w http.ResponseWriter, r *http.Request) {
	roomID := roomIDParam(r)
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

func (s *server) deliverMessages(w http.ResponseWriter, r *http.Request) {
	roomID := roomIDParam(r)
	var req messageReceiptRequest
	if !readJSON(w, r, &req) {
		return
	}
	req.UserID = strings.TrimSpace(req.UserID)
	if roomID == "" || req.UserID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "room and user required"})
		return
	}
	if len(directMessageRecipients(roomID)) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "delivery receipts are only supported in direct chats"})
		return
	}
	if !canAccessRoom(roomID, req.UserID) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "room access denied"})
		return
	}

	deliveredAt := time.Now().UTC()
	deliveredIDs, err := s.markMessagesDelivered(r.Context(), roomID, req.UserID, sanitizeMessageIDs(req.MessageIDs), deliveredAt)
	if err != nil {
		slog.Error("mark messages delivered", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "mark messages delivered failed"})
		return
	}
	if len(deliveredIDs) > 0 {
		envelope := outboundEnvelope{
			Type: "message:delivered",
			Data: map[string]any{
				"roomId":      roomID,
				"readerId":    req.UserID,
				"messageIds":  deliveredIDs,
				"deliveredAt": deliveredAt,
			},
		}
		for _, recipient := range directMessageRecipients(roomID) {
			s.publish(r.Context(), "user:"+recipient, envelope)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"messageIds": deliveredIDs, "deliveredAt": deliveredAt})
}

func (s *server) readMessages(w http.ResponseWriter, r *http.Request) {
	roomID := roomIDParam(r)
	var req messageReceiptRequest
	if !readJSON(w, r, &req) {
		return
	}
	req.UserID = strings.TrimSpace(req.UserID)
	if roomID == "" || req.UserID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "room and user required"})
		return
	}
	if len(directMessageRecipients(roomID)) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "read receipts are only supported in direct chats"})
		return
	}
	if !canAccessRoom(roomID, req.UserID) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "room access denied"})
		return
	}

	readAt := time.Now().UTC()
	readIDs, err := s.markMessagesRead(r.Context(), roomID, req.UserID, sanitizeMessageIDs(req.MessageIDs), strings.TrimSpace(req.LastReadMessageID), readAt)
	if err != nil {
		slog.Error("mark messages read", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "mark messages read failed"})
		return
	}
	if len(readIDs) > 0 {
		envelope := outboundEnvelope{
			Type: "message:read",
			Data: map[string]any{
				"roomId":     roomID,
				"readerId":   req.UserID,
				"messageIds": readIDs,
				"readAt":     readAt,
			},
		}
		for _, recipient := range directMessageRecipients(roomID) {
			s.publish(r.Context(), "user:"+recipient, envelope)
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{"messageIds": readIDs, "readAt": readAt})
}

func (s *server) createAttachment(w http.ResponseWriter, r *http.Request) {
	roomID := roomIDParam(r)
	var req createAttachmentRequest
	if !readJSON(w, r, &req) {
		return
	}
	req.SenderID = strings.TrimSpace(req.SenderID)
	req.Data = strings.TrimSpace(req.Data)
	if roomID == "" || req.SenderID == "" || req.Data == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "room, sender, and data required"})
		return
	}
	if len(directMessageRecipients(roomID)) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "attachments are only supported in direct chats"})
		return
	}
	if !canAccessRoom(roomID, req.SenderID) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "room access denied"})
		return
	}

	body, err := base64.StdEncoding.DecodeString(req.Data)
	if err != nil || len(body) == 0 || len(body) > maxAttachmentBodyBytes {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "attachment rejected"})
		return
	}

	nextAttachment := attachment{
		ID:        randomID(),
		RoomID:    roomID,
		SenderID:  req.SenderID,
		CreatedAt: time.Now().UTC(),
	}
	_, err = s.db.Exec(r.Context(), `
insert into attachments (id, room_id, sender_id, body, created_at)
values ($1, $2, $3, $4, $5)`,
		nextAttachment.ID, nextAttachment.RoomID, nextAttachment.SenderID, body, nextAttachment.CreatedAt)
	if err != nil {
		slog.Error("store attachment", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store attachment failed"})
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{"attachment": nextAttachment})
}

func (s *server) getAttachment(w http.ResponseWriter, r *http.Request) {
	roomID := roomIDParam(r)
	attachmentID := strings.TrimSpace(chi.URLParam(r, "attachmentID"))
	userID := strings.TrimSpace(r.URL.Query().Get("userId"))
	if roomID == "" || attachmentID == "" || userID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "room, attachment, and user required"})
		return
	}
	if len(directMessageRecipients(roomID)) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "attachments are only supported in direct chats"})
		return
	}
	if !canAccessRoom(roomID, userID) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "room access denied"})
		return
	}

	var item attachment
	var body []byte
	err := s.db.QueryRow(r.Context(), `
select id, room_id, sender_id, body, created_at
from attachments
where id = $1 and room_id = $2`, attachmentID, roomID).Scan(&item.ID, &item.RoomID, &item.SenderID, &body, &item.CreatedAt)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "attachment not found"})
		return
	}
	item.Data = base64.StdEncoding.EncodeToString(body)
	writeJSON(w, http.StatusOK, map[string]any{"attachment": item})
}

func (s *server) deleteMessages(w http.ResponseWriter, r *http.Request) {
	roomID := roomIDParam(r)
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

	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "delete chat failed"})
		return
	}
	defer tx.Rollback(r.Context())

	_, err = tx.Exec(r.Context(), `delete from attachments where room_id = $1`, roomID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "delete attachments failed"})
		return
	}
	tag, err := tx.Exec(r.Context(), `delete from messages where room_id = $1`, roomID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "delete messages failed"})
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "delete chat failed"})
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

	now := time.Now().UTC()
	_, _ = s.db.Exec(ctx, `update users set display_name = $1, last_seen_at = now() where id = $2`, displayName, userID)
	joinedMember := member{
		ID:              userID,
		DisplayName:     displayName,
		LastSeenAt:      now,
		LastReachableAt: now,
		Reachable:       true,
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
				CallID string `json:"callId"`
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
			callID := strings.TrimSpace(body.CallID)
			if callID == "" || len(callID) > 80 {
				callID = randomID()
			}
			payload := callPushPayload{
				CallID:    callID,
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
				CallID string `json:"callId"`
				Reason string `json:"reason"`
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
					"callId":   strings.TrimSpace(body.CallID),
					"senderId": userID,
					"sender":   displayName,
					"reason":   normalizeCallEndReason(body.Reason),
				},
			}
			s.publishCallEvent(ctx, targetRoomID, userID, envelope)
		case "call:reject":
			var body struct {
				RoomID string `json:"roomId"`
				CallID string `json:"callId"`
				Reason string `json:"reason"`
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
					"callId":   strings.TrimSpace(body.CallID),
					"senderId": userID,
					"sender":   displayName,
					"reason":   normalizeCallEndReason(body.Reason),
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

func normalizeCallEndReason(reason string) string {
	switch strings.TrimSpace(reason) {
	case "rejected":
		return "rejected"
	case "no-answer":
		return "no-answer"
	default:
		return ""
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
	s.enqueuePush(ctx, "call", func(ctx context.Context) {
		if err := dispatcher.DispatchCallPush(ctx, payload, devices); err != nil {
			slog.Error("dispatch call push", "error", err)
		}
	})
}

func (s *server) startPushWorkers(ctx context.Context) {
	if s.pushQueue == nil {
		return
	}
	for i := 0; i < pushWorkerCount; i++ {
		go func(workerID int) {
			for {
				select {
				case <-ctx.Done():
					return
				case job := <-s.pushQueue:
					if job == nil {
						continue
					}
					jobCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
					job(jobCtx)
					cancel()
				}
			}
		}(i)
	}
}

func (s *server) enqueuePush(ctx context.Context, kind string, job pushJob) {
	if s.pushQueue == nil {
		job(ctx)
		return
	}
	select {
	case s.pushQueue <- job:
	default:
		slog.Error("drop push job; queue full", "kind", kind, "capacity", cap(s.pushQueue))
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
	if text == "" || len(text) > maxMessageBodyBytes {
		return message{}, false
	}
	recipients := directMessageRecipients(roomID)

	msg := message{
		ID:        randomID(),
		RoomID:    roomID,
		SenderID:  senderID,
		Sender:    sender,
		Text:      text,
		CreatedAt: time.Now().UTC(),
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		slog.Error("begin store message", "error", err)
		return message{}, false
	}
	defer tx.Rollback(ctx)

	_, err = tx.Exec(ctx, `
insert into messages (id, room_id, sender_id, sender_name, body, created_at)
values ($1, $2, $3, $4, $5, $6)`,
		msg.ID, msg.RoomID, msg.SenderID, msg.Sender, msg.Text, msg.CreatedAt)
	if err != nil {
		slog.Error("store message", "error", err)
		return message{}, false
	}
	for _, recipient := range recipients {
		if recipient == senderID {
			continue
		}
		_, err := tx.Exec(ctx, `
insert into message_receipts (message_id, room_id, user_id)
values ($1, $2, $3)
on conflict (message_id, user_id) do nothing`, msg.ID, msg.RoomID, recipient)
		if err != nil {
			slog.Error("store message receipt", "error", err)
			return message{}, false
		}
	}
	if err := tx.Commit(ctx); err != nil {
		slog.Error("commit message", "error", err)
		return message{}, false
	}

	envelope := outboundEnvelope{Type: "message:new", Data: msg}
	s.publish(ctx, channel, envelope)
	for _, recipient := range recipients {
		if recipient != senderID {
			s.publish(ctx, "user:"+recipient, envelope)
		}
	}
	s.dispatchNativeMessagePush(ctx, msg, recipients)
	return msg, true
}

func (s *server) dispatchNativeMessagePush(ctx context.Context, msg message, recipients []string) {
	filtered := make([]string, 0, len(recipients))
	for _, recipient := range recipients {
		if recipient != msg.SenderID {
			filtered = append(filtered, recipient)
		}
	}
	if len(filtered) == 0 {
		return
	}
	dispatcher := s.push
	if dispatcher == nil {
		dispatcher = noopPushDispatcher{}
	}
	devices := s.pushDevicesForRecipients(ctx, filtered)
	devices = messagePushDevices(devices)
	if len(devices) == 0 {
		return
	}
	if err := s.storeMessageDeliveryAttempts(ctx, msg.ID, devices); err != nil {
		slog.Error("store message delivery attempts", "error", err)
		return
	}
	payload := messagePushPayload{
		MessageID: msg.ID,
		RoomID:    msg.RoomID,
		SenderID:  msg.SenderID,
		Sender:    msg.Sender,
		Preview:   "New private message",
	}
	s.enqueuePush(ctx, "message", func(ctx context.Context) {
		pendingDevices := s.pendingMessagePushDevices(ctx, payload.MessageID)
		if len(pendingDevices) == 0 {
			return
		}
		if err := dispatcher.DispatchMessagePush(ctx, payload, pendingDevices); err != nil {
			slog.Error("dispatch message push", "error", err)
			s.markMessageDeliveryAttempts(ctx, payload.MessageID, pendingDevices, "failed")
			return
		}
		s.markMessageDeliveryAttempts(ctx, payload.MessageID, pendingDevices, "sent")
	})
}

func messagePushDevices(devices []pushDevice) []pushDevice {
	filtered := make([]pushDevice, 0, len(devices))
	for _, device := range devices {
		switch device.PushTokenType {
		case "apns", "fcm":
			filtered = append(filtered, device)
		}
	}
	return filtered
}

func (s *server) storeMessageDeliveryAttempts(ctx context.Context, messageID string, devices []pushDevice) error {
	if len(devices) == 0 {
		return nil
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, device := range devices {
		_, err := tx.Exec(ctx, `
insert into message_delivery_attempts (message_id, device_id, recipient_user_id, platform, push_token_type)
values ($1, $2, $3, $4, $5)
on conflict (message_id, device_id) do nothing`,
			messageID, device.DeviceID, device.UserID, device.Platform, device.PushTokenType)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *server) pendingMessagePushDevices(ctx context.Context, messageID string) []pushDevice {
	rows, err := s.db.Query(ctx, `
select d.device_id, d.user_id, d.platform, d.push_token, d.push_token_type
from message_delivery_attempts mda
join devices d on d.device_id = mda.device_id
where mda.message_id = $1
  and mda.status = 'pending'
order by d.user_id, d.device_id`, messageID)
	if err != nil {
		slog.Error("load pending message push devices", "error", err)
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

func (s *server) markMessageDeliveryAttempts(ctx context.Context, messageID string, devices []pushDevice, status string) {
	if len(devices) == 0 {
		return
	}
	deviceIDs := make([]string, 0, len(devices))
	for _, device := range devices {
		deviceIDs = append(deviceIDs, device.DeviceID)
	}
	_, err := s.db.Exec(ctx, `
update message_delivery_attempts
set status = $3,
    updated_at = now()
where message_id = $1
  and device_id = any($2)
  and status = 'pending'`, messageID, deviceIDs, status)
	if err != nil {
		slog.Error("mark message delivery attempts", "status", status, "error", err)
	}
}

func (s *server) markMessagesDelivered(ctx context.Context, roomID, userID string, messageIDs []string, deliveredAt time.Time) ([]string, error) {
	rows, err := s.db.Query(ctx, `
update message_receipts mr
set delivered_at = coalesce(mr.delivered_at, $3)
from messages m
where mr.message_id = m.id
  and mr.room_id = $1
  and mr.user_id = $2
  and m.sender_id <> $2
  and (cardinality($4::text[]) = 0 or mr.message_id = any($4::text[]))
returning mr.message_id`, roomID, userID, deliveredAt, messageIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	deliveredIDs := make([]string, 0)
	for rows.Next() {
		var messageID string
		if err := rows.Scan(&messageID); err != nil {
			return nil, err
		}
		deliveredIDs = append(deliveredIDs, messageID)
	}
	if len(deliveredIDs) > 0 {
		_, err = s.db.Exec(ctx, `
update message_delivery_attempts
set status = 'delivered',
    updated_at = now()
where recipient_user_id = $1
  and message_id = any($2)
  and status in ('pending', 'sent')`, userID, deliveredIDs)
		if err != nil {
			return nil, err
		}
	}
	return deliveredIDs, nil
}

func (s *server) markMessagesRead(ctx context.Context, roomID, userID string, messageIDs []string, lastReadMessageID string, readAt time.Time) ([]string, error) {
	if len(messageIDs) == 0 && lastReadMessageID != "" {
		ids, err := s.messageIDsThrough(ctx, roomID, userID, lastReadMessageID)
		if err != nil {
			return nil, err
		}
		messageIDs = ids
	}
	rows, err := s.db.Query(ctx, `
update message_receipts mr
set delivered_at = coalesce(mr.delivered_at, $3),
    read_at = coalesce(mr.read_at, $3)
from messages m
where mr.message_id = m.id
  and mr.room_id = $1
  and mr.user_id = $2
  and m.sender_id <> $2
  and mr.read_at is null
  and (cardinality($4::text[]) = 0 or mr.message_id = any($4::text[]))
returning mr.message_id`, roomID, userID, readAt, messageIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	readIDs := make([]string, 0)
	for rows.Next() {
		var messageID string
		if err := rows.Scan(&messageID); err != nil {
			return nil, err
		}
		readIDs = append(readIDs, messageID)
	}
	if len(readIDs) > 0 {
		_, err = s.db.Exec(ctx, `
update message_delivery_attempts
set status = 'delivered',
    updated_at = now()
where recipient_user_id = $1
  and message_id = any($2)
  and status in ('pending', 'sent')`, userID, readIDs)
		if err != nil {
			return nil, err
		}
	}
	return readIDs, nil
}

func (s *server) messageIDsThrough(ctx context.Context, roomID, userID, lastReadMessageID string) ([]string, error) {
	var lastCreatedAt time.Time
	if err := s.db.QueryRow(ctx, `
select created_at
from messages
where id = $1 and room_id = $2`, lastReadMessageID, roomID).Scan(&lastCreatedAt); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, `
select id
from messages
where room_id = $1
  and sender_id <> $2
  and created_at <= $3
order by created_at`, roomID, userID, lastCreatedAt)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0)
	for rows.Next() {
		var messageID string
		if err := rows.Scan(&messageID); err != nil {
			return nil, err
		}
		ids = append(ids, messageID)
	}
	return ids, nil
}

func sanitizeMessageIDs(values []string) []string {
	if len(values) == 0 {
		return []string{}
	}
	seen := make(map[string]bool, len(values))
	cleaned := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || len(value) > 128 || seen[value] {
			continue
		}
		seen[value] = true
		cleaned = append(cleaned, value)
	}
	return cleaned
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

func apnsMessagePayload(payload messagePushPayload) map[string]any {
	return map[string]any{
		"aps": map[string]any{
			"alert": map[string]string{
				"title": payload.Sender,
				"body":  payload.Preview,
			},
			"sound": "message-notification.mp3",
		},
		"type":      "message:new",
		"messageId": payload.MessageID,
		"roomId":    payload.RoomID,
		"senderId":  payload.SenderID,
		"sender":    payload.Sender,
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
		},
	}
}

func fcmMessagePayload(payload messagePushPayload, token string) map[string]any {
	return map[string]any{
		"message": map[string]any{
			"token": token,
			"notification": map[string]string{
				"title": payload.Sender,
				"body":  payload.Preview,
			},
			"data": map[string]string{
				"type":      "message:new",
				"messageId": payload.MessageID,
				"roomId":    payload.RoomID,
				"senderId":  payload.SenderID,
				"sender":    payload.Sender,
			},
			"android": map[string]any{
				"priority": "HIGH",
				"notification": map[string]any{
					"channel_id": "private-messages",
					"sound":      "message_notification",
				},
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
	parts := strings.Split(normalizeRoomID(roomID), ":")
	if len(parts) == 3 && parts[0] == "dm" && parts[1] != "" && parts[2] != "" {
		return parts[1:]
	}
	return nil
}

func roomIDParam(r *http.Request) string {
	return normalizeRoomID(chi.URLParam(r, "roomID"))
}

func normalizeRoomID(roomID string) string {
	roomID = strings.TrimSpace(roomID)
	if decoded, err := url.PathUnescape(roomID); err == nil {
		roomID = decoded
	}
	return strings.TrimSpace(roomID)
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
