package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
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

func TestDirectMessageRecipientsAreExplicitPrivateRooms(t *testing.T) {
	recipients := directMessageRecipients("dm:alice:bob")
	if len(recipients) != 2 || recipients[0] != "alice" || recipients[1] != "bob" {
		t.Fatalf("unexpected recipients: %#v", recipients)
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
	if canAccessRoom("dm:alice:bob", "charlie") {
		t.Fatal("non-participant should not access private room")
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
	_, err = db.Exec(ctx, `insert into users (id, display_name) values ($1, $2)`, userID, "Lobby User")
	if err != nil {
		t.Fatalf("insert user: %v", err)
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

	app := &server{
		cfg:   config{sharedInviteCode: "home"},
		db:    db,
		redis: rdb,
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

	roomID := directMessageRecipientsRoom("alice", "bob")
	body, _ := json.Marshal(createMessageRequest{SenderID: "alice", DisplayName: "Alice", Text: "first private message"})
	req := httptest.NewRequest(http.MethodPost, "/rooms/"+roomID+"/messages", bytes.NewReader(body))
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("roomID", roomID)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
	rec := httptest.NewRecorder()
	app.createMessage(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected created, got %d: %s", rec.Code, rec.Body.String())
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
	if len(inboxPayload.Messages) != 1 || inboxPayload.Messages[0].SenderID != "alice" || inboxPayload.Messages[0].Text != "first private message" {
		t.Fatalf("unexpected inbox payload: %#v", inboxPayload.Messages)
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
	aliceRoomID := directMessageRecipientsRoom("alice", "bob")
	alice := dialTestWebSocket(t, server.URL, aliceRoomID, "alice", "Alice")
	defer alice.Close()

	drainJoinedEvents(t, bob, 2)
	drainJoinedEvents(t, charlie, 1)

	if err := alice.WriteJSON(wsEnvelope{
		Type: "call:ring",
		Data: json.RawMessage(`{"mode":"video"}`),
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
	}
	encodedPayload, _ := json.Marshal(received.Data)
	if err := json.Unmarshal(encodedPayload, &ringPayload); err != nil {
		t.Fatalf("decode ring payload: %v", err)
	}
	if ringPayload.RoomID != aliceRoomID || ringPayload.SenderID != "alice" || ringPayload.Mode != "video" {
		t.Fatalf("unexpected ring payload: %#v", ringPayload)
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
		Data: json.RawMessage(`{"mode":"voice"}`),
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
	}
	encodedPayload, _ := json.Marshal(received.Data)
	if err := json.Unmarshal(encodedPayload, &ringPayload); err != nil {
		t.Fatalf("decode ring payload: %v", err)
	}
	if ringPayload.RoomID != "home" || ringPayload.SenderID != "alice" || ringPayload.Mode != "voice" {
		t.Fatalf("unexpected ring payload: %#v", ringPayload)
	}

	if err := alice.WriteJSON(wsEnvelope{
		Type: "call:end",
		Data: json.RawMessage(`{"roomId":"home"}`),
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
	}
	encodedEndPayload, _ := json.Marshal(ended.Data)
	if err := json.Unmarshal(encodedEndPayload, &endPayload); err != nil {
		t.Fatalf("decode end payload: %v", err)
	}
	if endPayload.RoomID != "home" || endPayload.SenderID != "alice" {
		t.Fatalf("unexpected end payload: %#v", endPayload)
	}

	if err := bob.WriteJSON(wsEnvelope{
		Type: "call:reject",
		Data: json.RawMessage(`{"roomId":"home"}`),
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
	}
	encodedRejectPayload, _ := json.Marshal(rejected.Data)
	if err := json.Unmarshal(encodedRejectPayload, &rejectPayload); err != nil {
		t.Fatalf("decode reject payload: %v", err)
	}
	if rejectPayload.RoomID != "home" || rejectPayload.SenderID != "bob" {
		t.Fatalf("unexpected reject payload: %#v", rejectPayload)
	}
}

func resetIntegrationState(t *testing.T, ctx context.Context, db *pgxpool.Pool) {
	t.Helper()
	if _, err := db.Exec(ctx, `truncate table messages, users cascade`); err != nil {
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
