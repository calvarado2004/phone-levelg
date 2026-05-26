package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

func TestRandomIDIsHexAndUnique(t *testing.T) {
	first := randomID()
	second := randomID()

	if len(first) != 32 {
		t.Fatalf("expected 32 hex chars, got %d", len(first))
	}
	if first == second {
		t.Fatal("expected random IDs to be unique")
	}
}

func TestLoginRejectsInvalidInvite(t *testing.T) {
	app := &server{
		cfg: config{sharedInviteCode: "home"},
	}

	body, _ := json.Marshal(loginRequest{DisplayName: "Carlos", InviteCode: "wrong"})
	req := httptest.NewRequest(http.MethodPost, "/login", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	app.login(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthorized, got %d", rec.Code)
	}
}

func TestLoginRejectsMissingAccountEmail(t *testing.T) {
	app := &server{
		cfg: config{sharedInviteCode: "home"},
	}

	body, _ := json.Marshal(loginRequest{DisplayName: "Carlos", InviteCode: "home"})
	req := httptest.NewRequest(http.MethodPost, "/login", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	app.login(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthorized, got %d", rec.Code)
	}
}

func TestMessageKeySecretIsStableAndNotRawInvite(t *testing.T) {
	first := messageKeySecret("home")
	second := messageKeySecret(" home ")
	other := messageKeySecret("other")

	if first == "" {
		t.Fatal("expected message key secret")
	}
	if first != second {
		t.Fatal("expected trimmed invite code to produce stable message key secret")
	}
	if first == "home" {
		t.Fatal("message key secret must not echo the raw invite code")
	}
	if first == other {
		t.Fatal("different invite codes must produce different message key secrets")
	}
	if len(first) != 64 {
		t.Fatalf("expected sha256 hex message key secret, got %d chars", len(first))
	}
}

func TestDirectMessageRecipientsAreExplicitPrivateRooms(t *testing.T) {
	recipients := directMessageRecipients("dm:alice:bob")
	if len(recipients) != 2 || recipients[0] != "alice" || recipients[1] != "bob" {
		t.Fatalf("unexpected recipients: %#v", recipients)
	}

	encodedRecipients := directMessageRecipients("dm%3Aalice%3Abob")
	if len(encodedRecipients) != 2 || encodedRecipients[0] != "alice" || encodedRecipients[1] != "bob" {
		t.Fatalf("encoded direct room should parse as private: %#v", encodedRecipients)
	}

	if recipients := directMessageRecipients("alice:bob"); recipients != nil {
		t.Fatalf("legacy non-prefixed room must not be treated as private: %#v", recipients)
	}
}

func TestDirectRoomAccessRequiresParticipant(t *testing.T) {
	if !canAccessRoom("home", "") {
		t.Fatal("public lobby room should be accessible")
	}
	if !canAccessRoom("dm:alice:bob", "alice") {
		t.Fatal("participant should access private room")
	}
	if !canAccessRoom("dm%3Aalice%3Abob", "bob") {
		t.Fatal("participant should access encoded private room")
	}
	if canAccessRoom("dm:alice:bob", "charlie") {
		t.Fatal("non-participant should not access private room")
	}
}

func TestSanitizeMessageIDsTrimsDeduplicatesAndRejectsInvalidValues(t *testing.T) {
	longID := strings.Repeat("a", 129)
	cleaned := sanitizeMessageIDs([]string{" message-1 ", "", "message-1", longID, "message-2"})

	if len(cleaned) != 2 || cleaned[0] != "message-1" || cleaned[1] != "message-2" {
		t.Fatalf("unexpected sanitized message ids: %#v", cleaned)
	}
	if empty := sanitizeMessageIDs(nil); len(empty) != 0 {
		t.Fatalf("expected nil input to produce empty slice, got %#v", empty)
	}
}

func TestNormalizeAvatarURLAllowsOnlyHTTPS(t *testing.T) {
	if got := normalizeAvatarURL(" https://example.com/avatar.png "); got != "https://example.com/avatar.png" {
		t.Fatalf("expected https avatar URL, got %q", got)
	}
	if got := normalizeAvatarURL("http://example.com/avatar.png"); got != "" {
		t.Fatalf("expected non-https avatar URL to be rejected, got %q", got)
	}
}

func TestRegisterDeviceRejectsInvalidPlatform(t *testing.T) {
	app := &server{}
	body, _ := json.Marshal(deviceRegistrationRequest{
		UserID:        "carlos@example.com",
		DeviceID:      "iphone",
		Platform:      "windows",
		PushToken:     "token",
		PushTokenType: "fcm",
	})
	req := httptest.NewRequest(http.MethodPost, "/devices/register", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	app.registerDevice(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected bad request, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestBuildPushDispatcherMissingCredentialsIsNoop(t *testing.T) {
	dispatcher := buildPushDispatcher(config{})
	if _, ok := dispatcher.(noopPushDispatcher); !ok {
		t.Fatalf("expected noop dispatcher without credentials, got %T", dispatcher)
	}
	if err := dispatcher.DispatchCallPush(context.Background(), callPushPayload{}, []pushDevice{{PushTokenType: "fcm"}}); err != nil {
		t.Fatalf("noop dispatcher must not fail local calls: %v", err)
	}
}

func TestBuildPushDispatcherEnablesConfiguredProviders(t *testing.T) {
	dispatcher := buildPushDispatcher(config{
		apnsTeamID:     "TEAMID",
		apnsKeyID:      "KEYID",
		apnsBundleID:   "io.levelg.phone",
		apnsPrivateKey: testAPNSPrivateKeyPEM(t),
		apnsEndpoint:   "https://api.sandbox.push.apple.com",
		fcmProjectID:   "phone-levelg",
		fcmAccessToken: "token",
	})
	composite, ok := dispatcher.(compositePushDispatcher)
	if !ok {
		t.Fatalf("expected composite dispatcher, got %T", dispatcher)
	}
	if composite.apns == nil || composite.fcm == nil {
		t.Fatalf("expected both providers to be enabled: %#v", composite)
	}
}

func TestBuildPushDispatcherEnablesFCMServiceAccount(t *testing.T) {
	dispatcher := buildPushDispatcher(config{
		fcmServiceAccount: testGoogleServiceAccountJSON(t, "phone-levelg", "https://oauth2.example/token"),
	})
	composite, ok := dispatcher.(compositePushDispatcher)
	if !ok {
		t.Fatalf("expected composite dispatcher, got %T", dispatcher)
	}
	if composite.fcm == nil {
		t.Fatalf("expected fcm provider to be enabled: %#v", composite)
	}
	if composite.fcm.projectID != "phone-levelg" {
		t.Fatalf("expected project id from service account, got %q", composite.fcm.projectID)
	}
	if composite.fcm.endpoint != "https://fcm.googleapis.com/v1/projects/phone-levelg/messages:send" {
		t.Fatalf("unexpected fcm endpoint: %q", composite.fcm.endpoint)
	}
}

func TestFCMServiceAccountMintsAndCachesAccessToken(t *testing.T) {
	accountJSON := testGoogleServiceAccountJSON(t, "phone-levelg", "")
	account, err := parseGoogleServiceAccount(accountJSON)
	if err != nil {
		t.Fatalf("parse service account: %v", err)
	}
	tokenRequests := 0
	account.TokenURI = "https://oauth2.example/token"
	provider := &fcmProvider{
		serviceAccount: account,
		client: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			tokenRequests++
			if r.Method != http.MethodPost {
				t.Fatalf("expected post, got %s", r.Method)
			}
			if err := r.ParseForm(); err != nil {
				t.Fatalf("parse token form: %v", err)
			}
			if r.Form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:jwt-bearer" || r.Form.Get("assertion") == "" {
				t.Fatalf("unexpected token request form: %v", r.Form)
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Status:     "200 OK",
				Header:     http.Header{"content-type": []string{"application/json"}},
				Body:       io.NopCloser(strings.NewReader(`{"access_token":"oauth-token","expires_in":3600}`)),
			}, nil
		})},
	}

	firstToken, err := provider.bearerToken(context.Background())
	if err != nil {
		t.Fatalf("first bearer token: %v", err)
	}
	secondToken, err := provider.bearerToken(context.Background())
	if err != nil {
		t.Fatalf("second bearer token: %v", err)
	}
	if firstToken != "oauth-token" || secondToken != "oauth-token" {
		t.Fatalf("unexpected tokens: %q %q", firstToken, secondToken)
	}
	if tokenRequests != 1 {
		t.Fatalf("expected cached token after one request, got %d requests", tokenRequests)
	}
}

func TestEnqueuePushHandlesHundredsOfJobs(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	app := &server{pushQueue: make(chan pushJob, pushQueueCapacity)}
	app.startPushWorkers(ctx)

	var wg sync.WaitGroup
	var mu sync.Mutex
	completed := 0
	const total = 1000
	for i := 0; i < total; i++ {
		wg.Add(1)
		app.enqueuePush(ctx, "test", func(context.Context) {
			defer wg.Done()
			mu.Lock()
			completed++
			mu.Unlock()
		})
	}

	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for queued push jobs")
	}
	if completed != total {
		t.Fatalf("expected %d completed jobs, got %d", total, completed)
	}
}

func TestCallPushPayloadShapesAPNSAndFCM(t *testing.T) {
	expiresAt := time.Date(2026, 5, 25, 1, 2, 3, 0, time.UTC)
	payload := callPushPayload{
		CallID:    "call-1",
		RoomID:    "dm:alice:bob",
		SenderID:  "alice@example.com",
		Sender:    "Alice",
		Mode:      "video",
		ExpiresAt: expiresAt,
	}

	apnsPayload := apnsCallPayload(payload)
	if apnsPayload["callId"] != "call-1" || apnsPayload["mode"] != "video" || apnsPayload["expiresAt"] != expiresAt.Format(time.RFC3339Nano) {
		t.Fatalf("unexpected apns payload: %#v", apnsPayload)
	}
	fcmPayload := fcmCallPayload(payload, "fcm-token")
	message := fcmPayload["message"].(map[string]any)
	data := message["data"].(map[string]string)
	if message["token"] != "fcm-token" || data["type"] != "call:ring" || data["callId"] != "call-1" || data["mode"] != "video" {
		t.Fatalf("unexpected fcm payload: %#v", fcmPayload)
	}
	android := message["android"].(map[string]any)
	if android["priority"] != "HIGH" {
		t.Fatalf("expected high-priority android FCM payload: %#v", fcmPayload)
	}
	if _, ok := message["notification"]; ok {
		t.Fatalf("android call pushes must be data-only so the native FirebaseMessagingService handles background calls: %#v", fcmPayload)
	}

	messagePayload := messagePushPayload{
		MessageID: "message-1",
		RoomID:    "dm:alice:bob",
		SenderID:  "alice",
		Sender:    "Alice",
		Preview:   "New private message",
	}
	apnsMessage := apnsMessagePayload(messagePayload)
	if apnsMessage["type"] != "message:new" || apnsMessage["messageId"] != "message-1" {
		t.Fatalf("unexpected apns message payload: %#v", apnsMessage)
	}
	fcmMessage := fcmMessagePayload(messagePayload, "fcm-token")
	fcmEnvelope := fcmMessage["message"].(map[string]any)
	fcmNotification := fcmEnvelope["notification"].(map[string]string)
	if fcmEnvelope["token"] != "fcm-token" || fcmNotification["title"] != "Alice" {
		t.Fatalf("unexpected fcm message payload: %#v", fcmMessage)
	}
	fcmAndroidNotification := fcmEnvelope["android"].(map[string]any)["notification"].(map[string]any)
	if fcmAndroidNotification["channel_id"] != "private-messages" || fcmAndroidNotification["sound"] != "message_notification" {
		t.Fatalf("expected private-message android channel and sound: %#v", fcmMessage)
	}
}

func TestRetryEventuallySucceeds(t *testing.T) {
	attempts := 0
	err := retry(context.Background(), "test", func(context.Context) error {
		attempts++
		if attempts < 3 {
			return errors.New("not ready")
		}
		return nil
	})

	if err != nil {
		t.Fatalf("expected retry to succeed: %v", err)
	}
	if attempts != 3 {
		t.Fatalf("expected 3 attempts, got %d", attempts)
	}
}

func TestIntegrationLoginUsesEmailAsStableAccount(t *testing.T) {
	databaseURL := os.Getenv("INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set INTEGRATION_DATABASE_URL to run integration tests")
	}

	ctx := context.Background()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer db.Close()

	if err := migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	resetIntegrationState(t, ctx, db)

	app := &server{
		cfg: config{sharedInviteCode: "home"},
		db:  db,
	}

	first := loginForTest(t, app, loginRequest{
		DisplayName:  "Carlos",
		AccountEmail: "Carlos@example.com",
		AvatarURL:    "https://example.com/carlos.png",
		InviteCode:   "home",
	})
	second := loginForTest(t, app, loginRequest{
		DisplayName:  "Carlitos",
		AccountEmail: "carlos@example.com",
		AvatarURL:    "http://example.com/rejected.png",
		InviteCode:   "home",
	})

	if first.UserID != second.UserID {
		t.Fatalf("expected same user id for same email, got %q and %q", first.UserID, second.UserID)
	}
	if second.UserID != "carlos@example.com" {
		t.Fatalf("expected normalized email as user id, got %q", second.UserID)
	}
	if second.DisplayName != "Carlitos" {
		t.Fatalf("expected display name update, got %q", second.DisplayName)
	}
	if second.AccountEmail != "carlos@example.com" {
		t.Fatalf("expected normalized account email, got %q", second.AccountEmail)
	}
	if first.AvatarURL != "https://example.com/carlos.png" {
		t.Fatalf("expected https avatar URL on first login, got %q", first.AvatarURL)
	}
	if second.AvatarURL != "" {
		t.Fatalf("expected unsafe avatar URL to be rejected, got %q", second.AvatarURL)
	}
}

func TestIntegrationLoginAllowsSameDisplayNameForDifferentEmails(t *testing.T) {
	databaseURL := os.Getenv("INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set INTEGRATION_DATABASE_URL to run integration tests")
	}

	ctx := context.Background()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer db.Close()

	if err := migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	resetIntegrationState(t, ctx, db)

	app := &server{
		cfg: config{sharedInviteCode: "home"},
		db:  db,
	}

	first := loginForTest(t, app, loginRequest{
		DisplayName:  "Carlos",
		AccountEmail: "carlos@example.com",
		InviteCode:   "home",
	})
	second := loginForTest(t, app, loginRequest{
		DisplayName:  "Carlos",
		AccountEmail: "carlitos@example.com",
		InviteCode:   "home",
	})

	if first.UserID == second.UserID {
		t.Fatalf("expected different users for different emails, got %q", first.UserID)
	}
	if first.UserID != "carlos@example.com" || second.UserID != "carlitos@example.com" {
		t.Fatalf("expected email-backed user ids, got %q and %q", first.UserID, second.UserID)
	}
	if first.DisplayName != second.DisplayName {
		t.Fatalf("expected display names to match, got %q and %q", first.DisplayName, second.DisplayName)
	}
}

func TestIntegrationLoginReusesSameEmailAccount(t *testing.T) {
	databaseURL := os.Getenv("INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set INTEGRATION_DATABASE_URL to run integration tests")
	}

	ctx := context.Background()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer db.Close()

	if err := migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	resetIntegrationState(t, ctx, db)

	app := &server{
		cfg: config{sharedInviteCode: "home"},
		db:  db,
	}

	first := loginForTest(t, app, loginRequest{
		DisplayName:  "Carlos iPhone",
		AccountEmail: "Carlos@example.com",
		InviteCode:   "home",
	})
	second := loginForTest(t, app, loginRequest{
		DisplayName:  "Carlos Android",
		AccountEmail: " carlos@example.com ",
		InviteCode:   "home",
	})

	if first.UserID != "carlos@example.com" || second.UserID != first.UserID {
		t.Fatalf("expected same normalized email-backed account, got first=%q second=%q", first.UserID, second.UserID)
	}
	var count int
	var displayName string
	if err := db.QueryRow(ctx, `select count(*), max(display_name) from users where id = 'carlos@example.com'`).Scan(&count, &displayName); err != nil {
		t.Fatalf("query users: %v", err)
	}
	if count != 1 || displayName != "Carlos Android" {
		t.Fatalf("expected one updated account row, got count=%d display=%q", count, displayName)
	}
}

func TestIntegrationLoginUsesVerifiedGoogleIdentity(t *testing.T) {
	databaseURL := os.Getenv("INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set INTEGRATION_DATABASE_URL to run integration tests")
	}

	ctx := context.Background()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer db.Close()

	if err := migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	resetIntegrationState(t, ctx, db)

	var authorization string
	googleServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization = r.Header.Get("authorization")
		writeJSON(w, http.StatusOK, googleUserInfo{
			Email:         "Carlos@Example.com",
			EmailVerified: true,
			Name:          "Carlos Google",
			Picture:       "https://example.com/carlos.png",
		})
	}))
	defer googleServer.Close()

	app := &server{
		cfg: config{sharedInviteCode: "home", googleUserInfoURL: googleServer.URL},
		db:  db,
	}
	session := loginForTest(t, app, loginRequest{
		DisplayName:       "Ignored",
		AccountEmail:      "ignored@example.com",
		GoogleAccessToken: "google-token",
		InviteCode:        "home",
	})

	if authorization != "Bearer google-token" {
		t.Fatalf("expected bearer token forwarded to Google, got %q", authorization)
	}
	if session.UserID != "carlos@example.com" || session.AccountEmail != "carlos@example.com" || session.DisplayName != "Carlos Google" || session.AvatarURL != "https://example.com/carlos.png" {
		t.Fatalf("expected verified Google identity to drive login, got %#v", session)
	}
	if session.MessageKeySecret == "" || session.MessageKeySecret == "home" {
		t.Fatalf("expected login to return a canonical non-raw message key secret, got %q", session.MessageKeySecret)
	}
	secondSession := loginForTest(t, app, loginRequest{
		DisplayName:       "Ignored Again",
		AccountEmail:      "ignored-again@example.com",
		GoogleAccessToken: "google-token",
		InviteCode:        "home",
	})
	if secondSession.MessageKeySecret != session.MessageKeySecret {
		t.Fatal("same server invite must return the same message key secret on every device login")
	}
}

func TestIntegrationLoginRejectsUnverifiedGoogleEmail(t *testing.T) {
	databaseURL := os.Getenv("INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set INTEGRATION_DATABASE_URL to run integration tests")
	}

	ctx := context.Background()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer db.Close()

	if err := migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	resetIntegrationState(t, ctx, db)

	googleServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, googleUserInfo{
			Email:         "carlos@example.com",
			EmailVerified: false,
			Name:          "Carlos Google",
		})
	}))
	defer googleServer.Close()

	app := &server{
		cfg: config{sharedInviteCode: "home", googleUserInfoURL: googleServer.URL},
		db:  db,
	}
	body, _ := json.Marshal(loginRequest{GoogleAccessToken: "google-token", InviteCode: "home"})
	req := httptest.NewRequest(http.MethodPost, "/login", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	app.login(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected unverified Google email to be rejected, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestIntegrationDeviceRegistrationUsesEmailBackedUser(t *testing.T) {
	databaseURL := os.Getenv("INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set INTEGRATION_DATABASE_URL to run integration tests")
	}

	ctx := context.Background()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer db.Close()

	if err := migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	resetIntegrationState(t, ctx, db)

	app := &server{
		cfg: config{sharedInviteCode: "home"},
		db:  db,
	}
	session := loginForTest(t, app, loginRequest{
		DisplayName:  "Carlos",
		AccountEmail: "Carlos@example.com",
		InviteCode:   "home",
	})

	body, _ := json.Marshal(deviceRegistrationRequest{
		UserID:        session.UserID,
		DeviceID:      "iphone-16-pro",
		Platform:      "ios",
		PushToken:     "voip-token-1",
		PushTokenType: "apns-voip",
		AppVersion:    "0.1.0",
	})
	req := httptest.NewRequest(http.MethodPost, "/devices/register", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	app.registerDevice(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected register ok, got %d: %s", rec.Code, rec.Body.String())
	}

	updateBody, _ := json.Marshal(deviceRegistrationRequest{
		UserID:        session.UserID,
		DeviceID:      "iphone-16-pro",
		Platform:      "ios",
		PushToken:     "voip-token-2",
		PushTokenType: "apns-voip",
		AppVersion:    "0.1.1",
	})
	updateReq := httptest.NewRequest(http.MethodPost, "/devices/register", bytes.NewReader(updateBody))
	updateRec := httptest.NewRecorder()
	app.registerDevice(updateRec, updateReq)
	if updateRec.Code != http.StatusOK {
		t.Fatalf("expected update ok, got %d: %s", updateRec.Code, updateRec.Body.String())
	}

	var count int
	var userID, token, appVersion string
	if err := db.QueryRow(ctx, `select count(*), max(user_id), max(push_token), max(app_version) from devices`).Scan(&count, &userID, &token, &appVersion); err != nil {
		t.Fatalf("query devices: %v", err)
	}
	if count != 1 || userID != "carlos@example.com" || token != "voip-token-2" || appVersion != "0.1.1" {
		t.Fatalf("unexpected device row: count=%d user=%q token=%q app=%q", count, userID, token, appVersion)
	}

	deleteReq := httptest.NewRequest(http.MethodDelete, "/devices/iphone-16-pro?userId="+url.QueryEscape(session.UserID), nil)
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("deviceID", "iphone-16-pro")
	deleteReq = deleteReq.WithContext(context.WithValue(deleteReq.Context(), chi.RouteCtxKey, routeCtx))
	deleteRec := httptest.NewRecorder()
	app.deleteDevice(deleteRec, deleteReq)
	if deleteRec.Code != http.StatusOK {
		t.Fatalf("expected delete ok, got %d: %s", deleteRec.Code, deleteRec.Body.String())
	}
	if err := db.QueryRow(ctx, `select count(*) from devices`).Scan(&count); err != nil {
		t.Fatalf("count devices after delete: %v", err)
	}
	if count != 0 {
		t.Fatalf("expected device delete, got count %d", count)
	}
}

func TestIntegrationDeviceRegistrationKeepsThreePhysicalDevices(t *testing.T) {
	databaseURL := os.Getenv("INTEGRATION_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set INTEGRATION_DATABASE_URL to run integration tests")
	}

	ctx := context.Background()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer db.Close()

	if err := migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	resetIntegrationState(t, ctx, db)

	app := &server{
		cfg: config{sharedInviteCode: "home"},
		db:  db,
	}
	session := loginForTest(t, app, loginRequest{
		DisplayName:  "Carlos",
		AccountEmail: "carlos@example.com",
		InviteCode:   "home",
	})

	devices := []deviceRegistrationRequest{
		{UserID: session.UserID, DeviceID: "ios-a", Platform: "ios", PushToken: "apns-a", PushTokenType: "apns", AppVersion: "0.1.0"},
		{UserID: session.UserID, DeviceID: "ios-a:voip", Platform: "ios", PushToken: "voip-a", PushTokenType: "apns-voip", AppVersion: "0.1.0"},
		{UserID: session.UserID, DeviceID: "android-b", Platform: "android", PushToken: "fcm-b", PushTokenType: "fcm", AppVersion: "0.1.0"},
		{UserID: session.UserID, DeviceID: "ios-c", Platform: "ios", PushToken: "apns-c", PushTokenType: "apns", AppVersion: "0.1.0"},
		{UserID: session.UserID, DeviceID: "android-d", Platform: "android", PushToken: "fcm-d", PushTokenType: "fcm", AppVersion: "0.1.0"},
	}
	for _, item := range devices {
		body, _ := json.Marshal(item)
		req := httptest.NewRequest(http.MethodPost, "/devices/register", bytes.NewReader(body))
		rec := httptest.NewRecorder()
		app.registerDevice(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected register ok for %s, got %d: %s", item.DeviceID, rec.Code, rec.Body.String())
		}
		time.Sleep(time.Millisecond)
	}

	rows, err := db.Query(ctx, `select device_id from devices where user_id = $1 order by device_id`, session.UserID)
	if err != nil {
		t.Fatalf("query devices: %v", err)
	}
	defer rows.Close()
	remaining := make([]string, 0)
	for rows.Next() {
		var deviceID string
		if err := rows.Scan(&deviceID); err != nil {
			t.Fatalf("scan device: %v", err)
		}
		remaining = append(remaining, deviceID)
	}
	if strings.Contains(strings.Join(remaining, ","), "ios-a") {
		t.Fatalf("expected oldest physical device group to be pruned, remaining=%v", remaining)
	}
	if len(remaining) != 3 {
		t.Fatalf("expected three physical devices after pruning, got rows=%v", remaining)
	}
}

func TestIntegrationMessageHistory(t *testing.T) {
	databaseURL := os.Getenv("INTEGRATION_DATABASE_URL")
	redisAddr := os.Getenv("INTEGRATION_REDIS_ADDR")
	if databaseURL == "" || redisAddr == "" {
		t.Skip("set INTEGRATION_DATABASE_URL and INTEGRATION_REDIS_ADDR to run integration tests")
	}

	ctx := context.Background()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer db.Close()

	if err := migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	resetIntegrationState(t, ctx, db)

	rdb := redis.NewClient(&redis.Options{Addr: redisAddr})
	defer rdb.Close()

	app := &server{
		cfg:   config{sharedInviteCode: "home"},
		db:    db,
		redis: rdb,
	}

	userID := randomID()
	_, err = db.Exec(ctx, `insert into users (id, display_name) values ($1, $2)`, userID, "Carlos")
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}

	app.storeAndPublishMessage(ctx, "room:home", "home", userID, "Carlos", "hello 👋")

	req := httptest.NewRequest(http.MethodGet, "/rooms/home/messages", nil)
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("roomID", "home")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
	rec := httptest.NewRecorder()
	app.messages(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected ok, got %d: %s", rec.Code, rec.Body.String())
	}

	var payload struct {
		Messages []message `json:"messages"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(payload.Messages) == 0 {
		t.Fatal("expected at least one message")
	}
	if payload.Messages[len(payload.Messages)-1].Text != "hello 👋" {
		t.Fatalf("unexpected message text: %q", payload.Messages[len(payload.Messages)-1].Text)
	}
}

func TestIntegrationMembersLobby(t *testing.T) {
	databaseURL := os.Getenv("INTEGRATION_DATABASE_URL")
	redisAddr := os.Getenv("INTEGRATION_REDIS_ADDR")
	if databaseURL == "" || redisAddr == "" {
		t.Skip("set INTEGRATION_DATABASE_URL and INTEGRATION_REDIS_ADDR to run integration tests")
	}

	ctx := context.Background()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer db.Close()

	if err := migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	resetIntegrationState(t, ctx, db)

	rdb := redis.NewClient(&redis.Options{Addr: redisAddr})
	defer rdb.Close()

	app := &server{
		cfg:   config{sharedInviteCode: "home"},
		db:    db,
		redis: rdb,
	}

	userID := randomID()
	_, err = db.Exec(ctx, `insert into users (id, display_name, last_seen_at) values ($1, $2, now() - interval '45 days')`, userID, "Lobby User")
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}
	_, err = db.Exec(ctx, `
insert into devices (device_id, user_id, platform, push_token, push_token_type, last_seen_at)
values ('iphone', $1, 'ios', 'voip-token', 'apns-voip', now())`, userID)
	if err != nil {
		t.Fatalf("insert device: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/members", nil)
	rec := httptest.NewRecorder()
	app.members(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected ok, got %d: %s", rec.Code, rec.Body.String())
	}

	var payload struct {
		Members []member `json:"members"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(payload.Members) == 0 {
		t.Fatal("expected at least one lobby member")
	}
	if payload.Members[0].DisplayName == "" {
		t.Fatal("expected member display name")
	}
	if !payload.Members[0].Reachable {
		t.Fatal("expected device-backed member reachability")
	}
	if !payload.Members[0].LastReachableAt.After(payload.Members[0].LastSeenAt) {
		t.Fatal("expected lastReachableAt to include recent device registration")
	}
}

func TestIntegrationDirectMessageReachesRecipientUserChannelOnly(t *testing.T) {
	databaseURL := os.Getenv("INTEGRATION_DATABASE_URL")
	redisAddr := os.Getenv("INTEGRATION_REDIS_ADDR")
	if databaseURL == "" || redisAddr == "" {
		t.Skip("set INTEGRATION_DATABASE_URL and INTEGRATION_REDIS_ADDR to run integration tests")
	}

	ctx := context.Background()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer db.Close()

	if err := migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	resetIntegrationState(t, ctx, db)

	rdb := redis.NewClient(&redis.Options{Addr: redisAddr})
	defer rdb.Close()

	app := &server{
		cfg:      config{sharedInviteCode: "home"},
		db:       db,
		redis:    rdb,
		upgrader: websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }},
	}

	for _, item := range []member{
		{ID: "alice", DisplayName: "Alice"},
		{ID: "bob", DisplayName: "Bob"},
		{ID: "charlie", DisplayName: "Charlie"},
	} {
		_, err := db.Exec(ctx, `insert into users (id, display_name) values ($1, $2)`, item.ID, item.DisplayName)
		if err != nil {
			t.Fatalf("insert user %s: %v", item.ID, err)
		}
	}

	server := httptest.NewServer(http.HandlerFunc(app.websocket))
	defer server.Close()

	bob := dialTestWebSocket(t, server.URL, "home", "bob", "Bob")
	defer bob.Close()
	charlie := dialTestWebSocket(t, server.URL, "home", "charlie", "Charlie")
	defer charlie.Close()
	alice := dialTestWebSocket(t, server.URL, directMessageRecipientsRoom("alice", "bob"), "alice", "Alice")
	defer alice.Close()

	drainJoinedEvents(t, bob, 2)
	drainJoinedEvents(t, charlie, 1)

	if err := alice.WriteJSON(wsEnvelope{
		Type: "message:send",
		Data: json.RawMessage(`{"text":"private hello"}`),
	}); err != nil {
		t.Fatalf("send direct message: %v", err)
	}

	var received outboundEnvelope
	if err := bob.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("set bob deadline: %v", err)
	}
	if err := bob.ReadJSON(&received); err != nil {
		t.Fatalf("bob did not receive private message on user channel: %v", err)
	}
	if received.Type != "message:new" {
		t.Fatalf("expected message:new, got %q", received.Type)
	}

	if err := charlie.SetReadDeadline(time.Now().Add(300 * time.Millisecond)); err != nil {
		t.Fatalf("set charlie deadline: %v", err)
	}
	var leaked outboundEnvelope
	if err := charlie.ReadJSON(&leaked); err == nil {
		t.Fatalf("non-participant received private event: %#v", leaked)
	}
}

func TestIntegrationCreateDirectMessagePersistsAndStaysPrivate(t *testing.T) {
	databaseURL := os.Getenv("INTEGRATION_DATABASE_URL")
	redisAddr := os.Getenv("INTEGRATION_REDIS_ADDR")
	if databaseURL == "" || redisAddr == "" {
		t.Skip("set INTEGRATION_DATABASE_URL and INTEGRATION_REDIS_ADDR to run integration tests")
	}

	ctx := context.Background()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer db.Close()

	if err := migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	resetIntegrationState(t, ctx, db)

	rdb := redis.NewClient(&redis.Options{Addr: redisAddr})
	defer rdb.Close()
	pushRecorder := &recordingPushDispatcher{}

	app := &server{
		cfg:   config{sharedInviteCode: "home"},
		db:    db,
		redis: rdb,
		push:  pushRecorder,
	}
	for _, item := range []member{
		{ID: "alice", DisplayName: "Alice"},
		{ID: "bob", DisplayName: "Bob"},
		{ID: "charlie", DisplayName: "Charlie"},
	} {
		_, err := db.Exec(ctx, `insert into users (id, display_name) values ($1, $2)`, item.ID, item.DisplayName)
		if err != nil {
			t.Fatalf("insert user %s: %v", item.ID, err)
		}
	}
	for _, item := range []pushDevice{
		{DeviceID: "alice-phone", UserID: "alice", Platform: "ios", PushToken: "alice-token", PushTokenType: "apns"},
		{DeviceID: "bob-android", UserID: "bob", Platform: "android", PushToken: "bob-fcm-token", PushTokenType: "fcm"},
		{DeviceID: "bob-iphone", UserID: "bob", Platform: "ios", PushToken: "bob-apns-token", PushTokenType: "apns"},
		{DeviceID: "bob-voip", UserID: "bob", Platform: "ios", PushToken: "bob-voip-token", PushTokenType: "apns-voip"},
		{DeviceID: "charlie-phone", UserID: "charlie", Platform: "ios", PushToken: "charlie-token", PushTokenType: "apns"},
	} {
		_, err := db.Exec(ctx, `
insert into devices (device_id, user_id, platform, push_token, push_token_type)
values ($1, $2, $3, $4, $5)`, item.DeviceID, item.UserID, item.Platform, item.PushToken, item.PushTokenType)
		if err != nil {
			t.Fatalf("insert device %s: %v", item.DeviceID, err)
		}
	}

	roomID := directMessageRecipientsRoom("alice", "bob")
	encryptedEnvelope := "plgenc:v1:bm9uY2U=:Y2lwaGVydGV4dA=="
	body, _ := json.Marshal(createMessageRequest{SenderID: "alice", DisplayName: "Alice", Text: encryptedEnvelope})
	req := httptest.NewRequest(http.MethodPost, "/rooms/"+roomID+"/messages", bytes.NewReader(body))
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("roomID", roomID)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
	rec := httptest.NewRecorder()
	app.createMessage(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected created, got %d: %s", rec.Code, rec.Body.String())
	}
	pushMessage := pushRecorder.waitForMessage(t, 1)[0]
	if pushMessage.payload.MessageID == "" || pushMessage.payload.RoomID != roomID || pushMessage.payload.SenderID != "alice" || pushMessage.payload.Sender != "Alice" {
		t.Fatalf("unexpected message push payload: %#v", pushMessage.payload)
	}
	if pushMessage.payload.Preview != "New private message" {
		t.Fatalf("unexpected message push preview: %q", pushMessage.payload.Preview)
	}
	pushedTokens := map[string]bool{}
	for _, device := range pushMessage.devices {
		if device.UserID != "bob" {
			t.Fatalf("expected only bob account devices, got %#v", pushMessage.devices)
		}
		if device.PushTokenType == "apns-voip" {
			t.Fatalf("message push must not use voip token: %#v", pushMessage.devices)
		}
		pushedTokens[device.PushToken] = true
	}
	if len(pushMessage.devices) != 2 || !pushedTokens["bob-fcm-token"] || !pushedTokens["bob-apns-token"] {
		t.Fatalf("expected bob APNs alert and FCM message tokens, got %#v", pushMessage.devices)
	}

	inboxReq := httptest.NewRequest(http.MethodGet, "/direct/inbox?userId=bob", nil)
	inboxRec := httptest.NewRecorder()
	app.directInbox(inboxRec, inboxReq)
	if inboxRec.Code != http.StatusOK {
		t.Fatalf("expected inbox ok, got %d: %s", inboxRec.Code, inboxRec.Body.String())
	}
	var inboxPayload struct {
		Messages []message `json:"messages"`
	}
	if err := json.Unmarshal(inboxRec.Body.Bytes(), &inboxPayload); err != nil {
		t.Fatalf("decode inbox: %v", err)
	}
	if len(inboxPayload.Messages) != 1 || inboxPayload.Messages[0].SenderID != "alice" || inboxPayload.Messages[0].Text != encryptedEnvelope {
		t.Fatalf("unexpected inbox payload: %#v", inboxPayload.Messages)
	}

	readBody, _ := json.Marshal(readMessagesRequest{UserID: "bob", MessageIDs: []string{inboxPayload.Messages[0].ID}})
	readReq := httptest.NewRequest(http.MethodPost, "/rooms/"+roomID+"/messages/read", bytes.NewReader(readBody))
	readRouteCtx := chi.NewRouteContext()
	readRouteCtx.URLParams.Add("roomID", roomID)
	readReq = readReq.WithContext(context.WithValue(readReq.Context(), chi.RouteCtxKey, readRouteCtx))
	readRec := httptest.NewRecorder()
	app.readMessages(readRec, readReq)
	if readRec.Code != http.StatusOK {
		t.Fatalf("expected read receipt ok, got %d: %s", readRec.Code, readRec.Body.String())
	}
	var readPayload struct {
		MessageIDs []string  `json:"messageIds"`
		ReadAt     time.Time `json:"readAt"`
	}
	if err := json.Unmarshal(readRec.Body.Bytes(), &readPayload); err != nil {
		t.Fatalf("decode read receipt: %v", err)
	}
	if len(readPayload.MessageIDs) != 1 || readPayload.MessageIDs[0] != inboxPayload.Messages[0].ID || readPayload.ReadAt.IsZero() {
		t.Fatalf("unexpected read receipt payload: %#v", readPayload)
	}
	inboxAfterReadReq := httptest.NewRequest(http.MethodGet, "/direct/inbox?userId=bob", nil)
	inboxAfterReadRec := httptest.NewRecorder()
	app.directInbox(inboxAfterReadRec, inboxAfterReadReq)
	if inboxAfterReadRec.Code != http.StatusOK {
		t.Fatalf("expected inbox after read ok, got %d: %s", inboxAfterReadRec.Code, inboxAfterReadRec.Body.String())
	}
	var inboxAfterReadPayload struct {
		Messages []message `json:"messages"`
	}
	if err := json.Unmarshal(inboxAfterReadRec.Body.Bytes(), &inboxAfterReadPayload); err != nil {
		t.Fatalf("decode inbox after read: %v", err)
	}
	if len(inboxAfterReadPayload.Messages) != 0 {
		t.Fatalf("expected direct inbox to be empty after read receipt, got %#v", inboxAfterReadPayload.Messages)
	}
	aliceHistoryReq := httptest.NewRequest(http.MethodGet, "/rooms/"+roomID+"/messages?userId=alice", nil)
	aliceHistoryRouteCtx := chi.NewRouteContext()
	aliceHistoryRouteCtx.URLParams.Add("roomID", roomID)
	aliceHistoryReq = aliceHistoryReq.WithContext(context.WithValue(aliceHistoryReq.Context(), chi.RouteCtxKey, aliceHistoryRouteCtx))
	aliceHistoryRec := httptest.NewRecorder()
	app.messages(aliceHistoryRec, aliceHistoryReq)
	if aliceHistoryRec.Code != http.StatusOK {
		t.Fatalf("expected alice history ok, got %d: %s", aliceHistoryRec.Code, aliceHistoryRec.Body.String())
	}
	var aliceHistoryPayload struct {
		Messages []message `json:"messages"`
	}
	if err := json.Unmarshal(aliceHistoryRec.Body.Bytes(), &aliceHistoryPayload); err != nil {
		t.Fatalf("decode alice history: %v", err)
	}
	if len(aliceHistoryPayload.Messages) != 1 || aliceHistoryPayload.Messages[0].ReadAt == nil || aliceHistoryPayload.Messages[0].ReadAt.IsZero() {
		t.Fatalf("expected sender history to include read receipt, got %#v", aliceHistoryPayload.Messages)
	}

	attachmentBody, _ := json.Marshal(createAttachmentRequest{SenderID: "alice", Data: base64.StdEncoding.EncodeToString([]byte("encrypted-document-bytes"))})
	attachmentReq := httptest.NewRequest(http.MethodPost, "/rooms/"+roomID+"/attachments", bytes.NewReader(attachmentBody))
	attachmentRouteCtx := chi.NewRouteContext()
	attachmentRouteCtx.URLParams.Add("roomID", roomID)
	attachmentReq = attachmentReq.WithContext(context.WithValue(attachmentReq.Context(), chi.RouteCtxKey, attachmentRouteCtx))
	attachmentRec := httptest.NewRecorder()
	app.createAttachment(attachmentRec, attachmentReq)
	if attachmentRec.Code != http.StatusCreated {
		t.Fatalf("expected attachment created, got %d: %s", attachmentRec.Code, attachmentRec.Body.String())
	}
	var attachmentPayload struct {
		Attachment attachment `json:"attachment"`
	}
	if err := json.Unmarshal(attachmentRec.Body.Bytes(), &attachmentPayload); err != nil {
		t.Fatalf("decode attachment: %v", err)
	}
	if attachmentPayload.Attachment.ID == "" || attachmentPayload.Attachment.Data != "" {
		t.Fatalf("unexpected attachment create payload: %#v", attachmentPayload.Attachment)
	}

	getAttachmentReq := httptest.NewRequest(http.MethodGet, "/rooms/"+roomID+"/attachments/"+attachmentPayload.Attachment.ID+"?userId=bob", nil)
	getAttachmentRouteCtx := chi.NewRouteContext()
	getAttachmentRouteCtx.URLParams.Add("roomID", roomID)
	getAttachmentRouteCtx.URLParams.Add("attachmentID", attachmentPayload.Attachment.ID)
	getAttachmentReq = getAttachmentReq.WithContext(context.WithValue(getAttachmentReq.Context(), chi.RouteCtxKey, getAttachmentRouteCtx))
	getAttachmentRec := httptest.NewRecorder()
	app.getAttachment(getAttachmentRec, getAttachmentReq)
	if getAttachmentRec.Code != http.StatusOK {
		t.Fatalf("expected attachment read ok, got %d: %s", getAttachmentRec.Code, getAttachmentRec.Body.String())
	}
	var getAttachmentPayload struct {
		Attachment attachment `json:"attachment"`
	}
	if err := json.Unmarshal(getAttachmentRec.Body.Bytes(), &getAttachmentPayload); err != nil {
		t.Fatalf("decode attachment read: %v", err)
	}
	if getAttachmentPayload.Attachment.Data != base64.StdEncoding.EncodeToString([]byte("encrypted-document-bytes")) {
		t.Fatalf("unexpected attachment bytes: %#v", getAttachmentPayload.Attachment)
	}

	forbiddenAttachmentReq := httptest.NewRequest(http.MethodGet, "/rooms/"+roomID+"/attachments/"+attachmentPayload.Attachment.ID+"?userId=charlie", nil)
	forbiddenAttachmentRouteCtx := chi.NewRouteContext()
	forbiddenAttachmentRouteCtx.URLParams.Add("roomID", roomID)
	forbiddenAttachmentRouteCtx.URLParams.Add("attachmentID", attachmentPayload.Attachment.ID)
	forbiddenAttachmentReq = forbiddenAttachmentReq.WithContext(context.WithValue(forbiddenAttachmentReq.Context(), chi.RouteCtxKey, forbiddenAttachmentRouteCtx))
	forbiddenAttachmentRec := httptest.NewRecorder()
	app.getAttachment(forbiddenAttachmentRec, forbiddenAttachmentReq)
	if forbiddenAttachmentRec.Code != http.StatusForbidden {
		t.Fatalf("expected attachment read to reject non-participant, got %d", forbiddenAttachmentRec.Code)
	}

	forbiddenReq := httptest.NewRequest(http.MethodGet, "/rooms/"+roomID+"/messages?userId=charlie", nil)
	forbiddenRouteCtx := chi.NewRouteContext()
	forbiddenRouteCtx.URLParams.Add("roomID", roomID)
	forbiddenReq = forbiddenReq.WithContext(context.WithValue(forbiddenReq.Context(), chi.RouteCtxKey, forbiddenRouteCtx))
	forbiddenRec := httptest.NewRecorder()
	app.messages(forbiddenRec, forbiddenReq)
	if forbiddenRec.Code != http.StatusForbidden {
		t.Fatalf("expected private history to reject non-participant, got %d", forbiddenRec.Code)
	}

	deleteReq := httptest.NewRequest(http.MethodDelete, "/rooms/"+roomID+"/messages?userId=bob", nil)
	deleteRouteCtx := chi.NewRouteContext()
	deleteRouteCtx.URLParams.Add("roomID", roomID)
	deleteReq = deleteReq.WithContext(context.WithValue(deleteReq.Context(), chi.RouteCtxKey, deleteRouteCtx))
	deleteRec := httptest.NewRecorder()
	app.deleteMessages(deleteRec, deleteReq)
	if deleteRec.Code != http.StatusOK {
		t.Fatalf("expected direct chat delete ok, got %d: %s", deleteRec.Code, deleteRec.Body.String())
	}

	inboxAfterDeleteReq := httptest.NewRequest(http.MethodGet, "/direct/inbox?userId=bob", nil)
	inboxAfterDeleteRec := httptest.NewRecorder()
	app.directInbox(inboxAfterDeleteRec, inboxAfterDeleteReq)
	if inboxAfterDeleteRec.Code != http.StatusOK {
		t.Fatalf("expected inbox after delete ok, got %d: %s", inboxAfterDeleteRec.Code, inboxAfterDeleteRec.Body.String())
	}
	var inboxAfterDeletePayload struct {
		Messages []message `json:"messages"`
	}
	if err := json.Unmarshal(inboxAfterDeleteRec.Body.Bytes(), &inboxAfterDeletePayload); err != nil {
		t.Fatalf("decode inbox after delete: %v", err)
	}
	if len(inboxAfterDeletePayload.Messages) != 0 {
		t.Fatalf("expected direct inbox to be empty after delete, got %#v", inboxAfterDeletePayload.Messages)
	}
	var attachmentCount int
	if err := db.QueryRow(ctx, `select count(*) from attachments where room_id = $1`, roomID).Scan(&attachmentCount); err != nil {
		t.Fatalf("count attachments after delete: %v", err)
	}
	if attachmentCount != 0 {
		t.Fatalf("expected direct chat delete to remove attachments, got %d", attachmentCount)
	}

	deleteHomeReq := httptest.NewRequest(http.MethodDelete, "/rooms/home/messages?userId=bob", nil)
	deleteHomeRouteCtx := chi.NewRouteContext()
	deleteHomeRouteCtx.URLParams.Add("roomID", "home")
	deleteHomeReq = deleteHomeReq.WithContext(context.WithValue(deleteHomeReq.Context(), chi.RouteCtxKey, deleteHomeRouteCtx))
	deleteHomeRec := httptest.NewRecorder()
	app.deleteMessages(deleteHomeRec, deleteHomeReq)
	if deleteHomeRec.Code != http.StatusBadRequest {
		t.Fatalf("expected home room delete to be rejected, got %d", deleteHomeRec.Code)
	}
}

func TestIntegrationDirectCallRingCarriesRoomAndStaysPrivate(t *testing.T) {
	databaseURL := os.Getenv("INTEGRATION_DATABASE_URL")
	redisAddr := os.Getenv("INTEGRATION_REDIS_ADDR")
	if databaseURL == "" || redisAddr == "" {
		t.Skip("set INTEGRATION_DATABASE_URL and INTEGRATION_REDIS_ADDR to run integration tests")
	}

	ctx := context.Background()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer db.Close()

	if err := migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	resetIntegrationState(t, ctx, db)

	rdb := redis.NewClient(&redis.Options{Addr: redisAddr})
	defer rdb.Close()
	pushRecorder := &recordingPushDispatcher{}

	app := &server{
		cfg:      config{sharedInviteCode: "home"},
		db:       db,
		redis:    rdb,
		upgrader: websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }},
		push:     pushRecorder,
	}
	for _, item := range []member{
		{ID: "alice", DisplayName: "Alice"},
		{ID: "bob", DisplayName: "Bob"},
		{ID: "charlie", DisplayName: "Charlie"},
	} {
		_, err := db.Exec(ctx, `insert into users (id, display_name) values ($1, $2)`, item.ID, item.DisplayName)
		if err != nil {
			t.Fatalf("insert user %s: %v", item.ID, err)
		}
	}
	for _, item := range []pushDevice{
		{DeviceID: "alice-phone", UserID: "alice", Platform: "ios", PushToken: "alice-token", PushTokenType: "apns"},
		{DeviceID: "bob-phone", UserID: "bob", Platform: "android", PushToken: "bob-token", PushTokenType: "fcm"},
		{DeviceID: "bob-iphone", UserID: "bob", Platform: "ios", PushToken: "bob-voip-token", PushTokenType: "apns-voip"},
		{DeviceID: "charlie-phone", UserID: "charlie", Platform: "ios", PushToken: "charlie-token", PushTokenType: "apns"},
	} {
		_, err := db.Exec(ctx, `
insert into devices (device_id, user_id, platform, push_token, push_token_type)
values ($1, $2, $3, $4, $5)`, item.DeviceID, item.UserID, item.Platform, item.PushToken, item.PushTokenType)
		if err != nil {
			t.Fatalf("insert device %s: %v", item.DeviceID, err)
		}
	}

	server := httptest.NewServer(http.HandlerFunc(app.websocket))
	defer server.Close()

	bob := dialTestWebSocket(t, server.URL, "home", "bob", "Bob")
	defer bob.Close()
	charlie := dialTestWebSocket(t, server.URL, "home", "charlie", "Charlie")
	defer charlie.Close()
	aliceRoomID := directMessageRecipientsRoom("alice", "bob")
	alice := dialTestWebSocket(t, server.URL, aliceRoomID, "alice", "Alice")
	defer alice.Close()

	drainJoinedEvents(t, bob, 2)
	drainJoinedEvents(t, charlie, 1)

	if err := alice.WriteJSON(wsEnvelope{
		Type: "call:ring",
		Data: json.RawMessage(`{"callId":"alice-video-call-1","mode":"video"}`),
	}); err != nil {
		t.Fatalf("send direct call ring: %v", err)
	}

	var received outboundEnvelope
	if err := bob.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("set bob deadline: %v", err)
	}
	if err := bob.ReadJSON(&received); err != nil {
		t.Fatalf("bob did not receive private call ring on user channel: %v", err)
	}
	if received.Type != "call:ring" {
		t.Fatalf("expected call:ring, got %q", received.Type)
	}
	var ringPayload struct {
		RoomID   string `json:"roomId"`
		SenderID string `json:"senderId"`
		Sender   string `json:"sender"`
		Mode     string `json:"mode"`
		CallID   string `json:"callId"`
	}
	encodedPayload, _ := json.Marshal(received.Data)
	if err := json.Unmarshal(encodedPayload, &ringPayload); err != nil {
		t.Fatalf("decode ring payload: %v", err)
	}
	if ringPayload.RoomID != aliceRoomID || ringPayload.SenderID != "alice" || ringPayload.Mode != "video" {
		t.Fatalf("unexpected ring payload: %#v", ringPayload)
	}
	if ringPayload.CallID != "alice-video-call-1" {
		t.Fatalf("expected direct ring payload to preserve caller call id, got %q", ringPayload.CallID)
	}

	pushCall := pushRecorder.waitForCall(t, 1)[0]
	if pushCall.payload.CallID != ringPayload.CallID || pushCall.payload.RoomID != aliceRoomID || pushCall.payload.SenderID != "alice" || pushCall.payload.Mode != "video" {
		t.Fatalf("unexpected push payload: %#v", pushCall.payload)
	}
	if time.Until(pushCall.payload.ExpiresAt) <= 0 {
		t.Fatalf("expected future push expiration, got %s", pushCall.payload.ExpiresAt)
	}
	if len(pushCall.devices) != 2 {
		t.Fatalf("expected push to both bob devices, got %#v", pushCall.devices)
	}
	pushedTokens := map[string]bool{}
	for _, device := range pushCall.devices {
		if device.UserID != "bob" {
			t.Fatalf("expected only bob account devices, got %#v", pushCall.devices)
		}
		pushedTokens[device.PushToken] = true
	}
	if !pushedTokens["bob-token"] || !pushedTokens["bob-voip-token"] {
		t.Fatalf("expected bob android and iphone tokens, got %#v", pushCall.devices)
	}
	var callAttemptCount, callAttemptDeviceCount int
	if err := db.QueryRow(ctx, `select count(*) from call_attempts where call_id = $1 and room_id = $2 and sender_id = 'alice'`, ringPayload.CallID, aliceRoomID).Scan(&callAttemptCount); err != nil {
		t.Fatalf("query call attempts: %v", err)
	}
	if callAttemptCount != 1 {
		t.Fatalf("expected persisted call attempt, got %d", callAttemptCount)
	}
	if err := db.QueryRow(ctx, `select count(*) from call_attempt_devices where call_id = $1 and recipient_user_id = 'bob'`, ringPayload.CallID).Scan(&callAttemptDeviceCount); err != nil {
		t.Fatalf("query call attempt devices: %v", err)
	}
	if callAttemptDeviceCount != 2 {
		t.Fatalf("expected persisted call attempt devices for both bob devices, got %d", callAttemptDeviceCount)
	}

	if err := charlie.SetReadDeadline(time.Now().Add(300 * time.Millisecond)); err != nil {
		t.Fatalf("set charlie deadline: %v", err)
	}
	var leaked outboundEnvelope
	if err := charlie.ReadJSON(&leaked); err == nil {
		t.Fatalf("non-participant received private call ring: %#v", leaked)
	}
}

func TestIntegrationLobbyCallRingReachesMembersOnUserChannel(t *testing.T) {
	databaseURL := os.Getenv("INTEGRATION_DATABASE_URL")
	redisAddr := os.Getenv("INTEGRATION_REDIS_ADDR")
	if databaseURL == "" || redisAddr == "" {
		t.Skip("set INTEGRATION_DATABASE_URL and INTEGRATION_REDIS_ADDR to run integration tests")
	}

	ctx := context.Background()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer db.Close()

	if err := migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	resetIntegrationState(t, ctx, db)

	rdb := redis.NewClient(&redis.Options{Addr: redisAddr})
	defer rdb.Close()

	app := &server{
		cfg:      config{sharedInviteCode: "home"},
		db:       db,
		redis:    rdb,
		upgrader: websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }},
	}
	for _, item := range []member{
		{ID: "alice", DisplayName: "Alice"},
		{ID: "bob", DisplayName: "Bob"},
	} {
		_, err := db.Exec(ctx, `insert into users (id, display_name) values ($1, $2)`, item.ID, item.DisplayName)
		if err != nil {
			t.Fatalf("insert user %s: %v", item.ID, err)
		}
	}

	server := httptest.NewServer(http.HandlerFunc(app.websocket))
	defer server.Close()

	bob := dialTestWebSocket(t, server.URL, directMessageRecipientsRoom("alice", "bob"), "bob", "Bob")
	defer bob.Close()
	alice := dialTestWebSocket(t, server.URL, "home", "alice", "Alice")
	defer alice.Close()

	drainJoinedEvents(t, alice, 1)

	if err := alice.WriteJSON(wsEnvelope{
		Type: "call:ring",
		Data: json.RawMessage(`{"callId":"lobby-call-1","mode":"voice"}`),
	}); err != nil {
		t.Fatalf("send lobby call ring: %v", err)
	}

	var received outboundEnvelope
	if err := bob.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("set bob deadline: %v", err)
	}
	if err := bob.ReadJSON(&received); err != nil {
		t.Fatalf("bob did not receive lobby call ring on user channel: %v", err)
	}
	if received.Type != "call:ring" {
		t.Fatalf("expected call:ring, got %q", received.Type)
	}

	var ringPayload struct {
		RoomID   string `json:"roomId"`
		SenderID string `json:"senderId"`
		Mode     string `json:"mode"`
		CallID   string `json:"callId"`
	}
	encodedPayload, _ := json.Marshal(received.Data)
	if err := json.Unmarshal(encodedPayload, &ringPayload); err != nil {
		t.Fatalf("decode ring payload: %v", err)
	}
	if ringPayload.RoomID != "home" || ringPayload.SenderID != "alice" || ringPayload.Mode != "voice" {
		t.Fatalf("unexpected ring payload: %#v", ringPayload)
	}
	if ringPayload.CallID != "lobby-call-1" {
		t.Fatalf("expected lobby ring payload to preserve caller call id, got %q", ringPayload.CallID)
	}

	if err := alice.WriteJSON(wsEnvelope{
		Type: "call:end",
		Data: json.RawMessage(`{"roomId":"home","callId":"lobby-call-1","reason":"no-answer"}`),
	}); err != nil {
		t.Fatalf("send lobby call end: %v", err)
	}

	var ended outboundEnvelope
	if err := bob.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("set bob end deadline: %v", err)
	}
	if err := bob.ReadJSON(&ended); err != nil {
		t.Fatalf("bob did not receive lobby call end on user channel: %v", err)
	}
	if ended.Type != "call:end" {
		t.Fatalf("expected call:end, got %q", ended.Type)
	}
	var endPayload struct {
		RoomID   string `json:"roomId"`
		SenderID string `json:"senderId"`
		CallID   string `json:"callId"`
		Reason   string `json:"reason"`
	}
	encodedEndPayload, _ := json.Marshal(ended.Data)
	if err := json.Unmarshal(encodedEndPayload, &endPayload); err != nil {
		t.Fatalf("decode end payload: %v", err)
	}
	if endPayload.RoomID != "home" || endPayload.SenderID != "alice" || endPayload.CallID != "lobby-call-1" || endPayload.Reason != "no-answer" {
		t.Fatalf("unexpected end payload: %#v", endPayload)
	}

	if err := bob.WriteJSON(wsEnvelope{
		Type: "call:reject",
		Data: json.RawMessage(`{"roomId":"home","callId":"lobby-call-1","reason":"rejected"}`),
	}); err != nil {
		t.Fatalf("send lobby call reject: %v", err)
	}

	var rejected outboundEnvelope
	if err := alice.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("set alice reject deadline: %v", err)
	}
	if err := alice.ReadJSON(&rejected); err != nil {
		t.Fatalf("alice did not receive lobby call rejection on user channel: %v", err)
	}
	if rejected.Type != "call:reject" {
		t.Fatalf("expected call:reject, got %q", rejected.Type)
	}
	var rejectPayload struct {
		RoomID   string `json:"roomId"`
		SenderID string `json:"senderId"`
		CallID   string `json:"callId"`
		Reason   string `json:"reason"`
	}
	encodedRejectPayload, _ := json.Marshal(rejected.Data)
	if err := json.Unmarshal(encodedRejectPayload, &rejectPayload); err != nil {
		t.Fatalf("decode reject payload: %v", err)
	}
	if rejectPayload.RoomID != "home" || rejectPayload.SenderID != "bob" || rejectPayload.CallID != "lobby-call-1" || rejectPayload.Reason != "rejected" {
		t.Fatalf("unexpected reject payload: %#v", rejectPayload)
	}
}

func resetIntegrationState(t *testing.T, ctx context.Context, db *pgxpool.Pool) {
	t.Helper()
	if _, err := db.Exec(ctx, `truncate table call_attempts, messages, users cascade`); err != nil {
		t.Fatalf("reset integration state: %v", err)
	}
}

func loginForTest(t *testing.T, app *server, payload loginRequest) loginResponse {
	t.Helper()
	body, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/login", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	app.login(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected login ok, got %d: %s", rec.Code, rec.Body.String())
	}

	var response loginResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode login response: %v", err)
	}
	return response
}

func dialTestWebSocket(t *testing.T, serverURL, roomID, userID, displayName string) *websocket.Conn {
	t.Helper()
	wsURL := "ws" + strings.TrimPrefix(serverURL, "http") +
		"?roomId=" + url.QueryEscape(roomID) +
		"&userId=" + url.QueryEscape(userID) +
		"&displayName=" + url.QueryEscape(displayName)
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial websocket %s: %v", displayName, err)
	}
	return conn
}

func drainJoinedEvents(t *testing.T, conn *websocket.Conn, count int) {
	t.Helper()
	for i := 0; i < count; i++ {
		if err := conn.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
			t.Fatalf("set drain deadline: %v", err)
		}
		var event outboundEnvelope
		if err := conn.ReadJSON(&event); err != nil {
			t.Fatalf("drain joined event: %v", err)
		}
	}
}

func directMessageRecipientsRoom(firstID, secondID string) string {
	recipients := []string{firstID, secondID}
	if recipients[1] < recipients[0] {
		recipients[0], recipients[1] = recipients[1], recipients[0]
	}
	return "dm:" + recipients[0] + ":" + recipients[1]
}

type recordedPushCall struct {
	payload callPushPayload
	devices []pushDevice
}

type recordingPushDispatcher struct {
	mu       sync.Mutex
	calls    []recordedPushCall
	messages []recordedPushMessage
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func (r *recordingPushDispatcher) DispatchCallPush(_ context.Context, payload callPushPayload, devices []pushDevice) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	copiedDevices := append([]pushDevice(nil), devices...)
	r.calls = append(r.calls, recordedPushCall{payload: payload, devices: copiedDevices})
	return nil
}

type recordedPushMessage struct {
	payload messagePushPayload
	devices []pushDevice
}

func (r *recordingPushDispatcher) DispatchMessagePush(_ context.Context, payload messagePushPayload, devices []pushDevice) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	copiedDevices := append([]pushDevice(nil), devices...)
	r.messages = append(r.messages, recordedPushMessage{payload: payload, devices: copiedDevices})
	return nil
}

func (r *recordingPushDispatcher) waitForCall(t *testing.T, count int) []recordedPushCall {
	t.Helper()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		if len(r.calls) >= count {
			calls := append([]recordedPushCall(nil), r.calls...)
			r.mu.Unlock()
			return calls
		}
		r.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	t.Fatalf("expected %d push calls, got %d", count, len(r.calls))
	return nil
}

func (r *recordingPushDispatcher) waitForMessage(t *testing.T, count int) []recordedPushMessage {
	t.Helper()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		if len(r.messages) >= count {
			messages := append([]recordedPushMessage(nil), r.messages...)
			r.mu.Unlock()
			return messages
		}
		r.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	t.Fatalf("expected %d message pushes, got %d", count, len(r.messages))
	return nil
}

func testAPNSPrivateKeyPEM(t *testing.T) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate ecdsa key: %v", err)
	}
	encodedKey, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatalf("marshal ecdsa key: %v", err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encodedKey}))
}

func TestAPNSAuthorizationTokenIsCached(t *testing.T) {
	provider := newAPNSProvider(config{
		apnsTeamID:     "TEAMID",
		apnsKeyID:      "KEYID",
		apnsBundleID:   "io.levelg.phone",
		apnsPrivateKey: testAPNSPrivateKeyPEM(t),
		apnsEndpoint:   "https://api.sandbox.push.apple.com",
	})
	if provider == nil {
		t.Fatal("expected APNs provider")
	}

	now := time.Unix(1000, 0)
	first, err := provider.authorizationToken(now)
	if err != nil {
		t.Fatalf("first authorization token: %v", err)
	}
	second, err := provider.authorizationToken(now.Add(time.Minute))
	if err != nil {
		t.Fatalf("second authorization token: %v", err)
	}
	if first != second {
		t.Fatal("expected APNs authorization token to be cached")
	}
	third, err := provider.authorizationToken(now.Add(51 * time.Minute))
	if err != nil {
		t.Fatalf("third authorization token: %v", err)
	}
	if third == first {
		t.Fatal("expected APNs authorization token to refresh after cache expiry")
	}
}

func TestAPNSRetryableStatusDetection(t *testing.T) {
	if !isRetryableAPNSError(apnsStatusError{statusCode: http.StatusTooManyRequests}) {
		t.Fatal("expected APNs 429 to be retryable")
	}
	if !isRetryableAPNSError(apnsStatusError{statusCode: http.StatusInternalServerError}) {
		t.Fatal("expected APNs 5xx to be retryable")
	}
	if isRetryableAPNSError(apnsStatusError{statusCode: http.StatusBadRequest}) {
		t.Fatal("expected APNs 400 to be non-retryable")
	}
	if isRetryableAPNSError(errors.New("network")) {
		t.Fatal("expected non-status errors to be non-retryable")
	}
}

func testGoogleServiceAccountJSON(t *testing.T, projectID, tokenURI string) string {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate rsa key: %v", err)
	}
	encodedKey, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatalf("marshal rsa key: %v", err)
	}
	privateKey := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encodedKey}))
	payload, err := json.Marshal(map[string]string{
		"type":         "service_account",
		"project_id":   projectID,
		"client_email": "firebase-adminsdk@example.iam.gserviceaccount.com",
		"private_key":  privateKey,
		"token_uri":    tokenURI,
	})
	if err != nil {
		t.Fatalf("marshal service account json: %v", err)
	}
	return string(payload)
}
