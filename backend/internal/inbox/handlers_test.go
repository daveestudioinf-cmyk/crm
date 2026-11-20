package inbox_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/config"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/db"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/inbox"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type mockEvolution struct {
	mu    sync.Mutex
	calls []string
}

func (m *mockEvolution) SendText(_ context.Context, instanceName, phoneNumber, text string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls = append(m.calls, instanceName+":"+phoneNumber+":"+text)
	return nil
}

type mockThrottle struct {
	allow bool
	calls int
}

func (m *mockThrottle) AllowOutbound(_ context.Context, _ string, _ int) bool {
	m.calls++
	return m.allow
}

func withIdentity(r *http.Request, id auth.Identity) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), auth.IdentityKey, id))
}

func TestCheckBusinessHours(t *testing.T) {
	bh := map[string]any{
		"start":    "09:00",
		"end":      "18:00",
		"timezone": "America/Sao_Paulo",
	}
	loc, _ := time.LoadLocation("America/Sao_Paulo")

	// 12:00 BRT -> inside
	inside := time.Date(2026, 6, 15, 12, 0, 0, 0, loc)
	if !inbox.CheckBusinessHours(bh, inside) {
		t.Fatalf("expected 12:00 BRT to be inside business hours")
	}

	// 21:00 BRT -> outside
	outside := time.Date(2026, 6, 15, 21, 0, 0, 0, loc)
	if inbox.CheckBusinessHours(bh, outside) {
		t.Fatalf("expected 21:00 BRT to be outside business hours")
	}

	// Overnight wrap 22:00 - 06:00 UTC
	overnight := map[string]any{"start": "22:00", "end": "06:00", "timezone": "UTC"}
	if !inbox.CheckBusinessHours(overnight, time.Date(2026, 6, 15, 23, 30, 0, 0, time.UTC)) {
		t.Fatalf("expected 23:30 UTC to be inside overnight hours")
	}
	if inbox.CheckBusinessHours(overnight, time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("expected 12:00 UTC to be outside overnight hours")
	}

	// Empty config -> always allowed
	if !inbox.CheckBusinessHours(nil, outside) {
		t.Fatalf("expected empty business_hours to allow all times")
	}
}

func TestChunkTextAndTruncateRunesUTF8(t *testing.T) {
	// Multi-byte UTF-8 runes (emojis + accented Portuguese)
	s := strings.Repeat("áé🚀", 5) // 15 runes, 30+ bytes
	chunks := inbox.ChunkText(s, 4)
	if len(chunks) != 4 {
		t.Fatalf("expected 4 chunks, got %d", len(chunks))
	}
	for i, c := range chunks {
		if !utf8.ValidString(c) {
			t.Fatalf("chunk %d is not valid UTF-8: %q", i, c)
		}
	}
	if strings.Join(chunks, "") != s {
		t.Fatalf("rejoined chunks do not match original string")
	}

	trunc := inbox.TruncateRunes(s, 5)
	if !utf8.ValidString(trunc) || trunc != "áé🚀áé..." {
		t.Fatalf("unexpected TruncateRunes result: %q", trunc)
	}
}

func TestSendMessageInvalidContentTypeAndRBAC(t *testing.T) {
	h := &inbox.Handler{}
	r := chi.NewRouter()
	r.Get("/api/v1/conversations", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	r.Group(func(r chi.Router) {
		r.Use(auth.RequireRole("agent"))
		r.Post("/api/v1/conversations/{id}/messages", h.SendMessage)
		r.Post("/api/v1/media/upload", h.UploadMedia)
		r.Post("/api/v1/templates", h.CreateTemplate)
	})

	viewer := auth.Identity{UserID: "u-v", OrganizationID: "org-1", Role: "viewer"}
	agent := auth.Identity{UserID: "u-a", OrganizationID: "org-1", Role: "agent"}

	// Viewer allowed on GET
	recGet := httptest.NewRecorder()
	r.ServeHTTP(recGet, withIdentity(httptest.NewRequest(http.MethodGet, "/api/v1/conversations", nil), viewer))
	if recGet.Code != http.StatusOK {
		t.Fatalf("expected viewer GET 200, got %d", recGet.Code)
	}

	// Viewer blocked (403) on M2 mutations
	for _, path := range []string{"/api/v1/conversations/c1/messages", "/api/v1/media/upload", "/api/v1/templates"} {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"body":"hi"}`)), viewer))
		if rec.Code != http.StatusForbidden {
			t.Fatalf("expected 403 for viewer on %s, got %d", path, rec.Code)
		}
	}

	// Agent sending invalid content_type -> 400 Bad Request (before DB query)
	recBad := httptest.NewRecorder()
	r.ServeHTTP(recBad, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/conversations/c1/messages", strings.NewReader(`{"body":"hi","content_type":"video"}`)), agent))
	if recBad.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid content_type, got %d: %s", recBad.Code, recBad.Body.String())
	}
}

func TestMediaUploadAndGetLocalDiskAndTenantIsolation(t *testing.T) {
	tmpDir := t.TempDir()
	h := &inbox.Handler{
		Cfg: config.Config{UploadDir: tmpDir},
	}

	r := chi.NewRouter()
	r.Post("/api/v1/media/upload", h.UploadMedia)
	r.Get("/api/v1/media/{id}", h.GetMedia)

	orgA := auth.Identity{UserID: "u1", OrganizationID: "11111111-1111-1111-1111-111111111111", Role: "agent"}
	orgB := auth.Identity{UserID: "u2", OrganizationID: "22222222-2222-2222-2222-222222222222", Role: "agent"}

	// 1. Upload valid PNG
	pngBytes := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "avatar.png")
	_, _ = fw.Write(pngBytes)
	_ = mw.Close()

	req := withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/media/upload", &buf), orgA)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 on valid upload, got %d: %s", rec.Code, rec.Body.String())
	}
	var upResp struct {
		ID          string `json:"id"`
		URL         string `json:"url"`
		ContentType string `json:"content_type"`
		Filename    string `json:"filename"`
		Size        int    `json:"size"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &upResp); err != nil {
		t.Fatalf("unmarshal upload response: %v", err)
	}
	if upResp.ID == "" || upResp.URL != "/api/v1/media/"+upResp.ID || upResp.ContentType != "image/png" || upResp.Size != len(pngBytes) {
		t.Fatalf("unexpected upload response: %+v", upResp)
	}

	// 2. Get media as Org A -> 200 OK with exact bytes
	getReq := withIdentity(httptest.NewRequest(http.MethodGet, upResp.URL, nil), orgA)
	getRec := httptest.NewRecorder()
	r.ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("expected 200 for owning org, got %d", getRec.Code)
	}
	if !bytes.Equal(getRec.Body.Bytes(), pngBytes) {
		t.Fatalf("downloaded bytes mismatch")
	}

	// 3. Get media as Org B -> 404 Not Found (tenant isolation)
	getReqB := withIdentity(httptest.NewRequest(http.MethodGet, upResp.URL, nil), orgB)
	getRecB := httptest.NewRecorder()
	r.ServeHTTP(getRecB, getReqB)
	if getRecB.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for cross-tenant media access, got %d", getRecB.Code)
	}

	// 4. Reject disallowed content type (HTML)
	var htmlBuf bytes.Buffer
	mw2 := multipart.NewWriter(&htmlBuf)
	fw2, _ := mw2.CreateFormFile("file", "xss.html")
	_, _ = fw2.Write([]byte("<html><script>alert(1)</script></html>"))
	_ = mw2.Close()
	reqHTML := withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/media/upload", &htmlBuf), orgA)
	reqHTML.Header.Set("Content-Type", mw2.FormDataContentType())
	recHTML := httptest.NewRecorder()
	r.ServeHTTP(recHTML, reqHTML)
	if recHTML.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("expected 415 for html upload, got %d: %s", recHTML.Code, recHTML.Body.String())
	}
}

func TestMediaUploadMinioSigV4(t *testing.T) {
	store := map[string][]byte{}
	meta := map[string]string{}
	var mu sync.Mutex

	minioMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHdr := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHdr, "AWS4-HMAC-SHA256 ") || r.Header.Get("X-Amz-Date") == "" || r.Header.Get("X-Amz-Content-Sha256") == "" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		switch r.Method {
		case http.MethodPut:
			b, _ := io.ReadAll(r.Body)
			store[r.URL.Path] = b
			meta[r.URL.Path] = r.Header.Get("Content-Type")
			w.WriteHeader(http.StatusOK)
		case http.MethodGet:
			b, ok := store[r.URL.Path]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", meta[r.URL.Path])
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(b)
		}
	}))
	defer minioMock.Close()

	h := &inbox.Handler{
		Cfg: config.Config{
			MinioEndpoint:  minioMock.URL,
			MinioBucket:    "crm-media",
			MinioAccessKey: "minioadmin",
			MinioSecretKey: "miniosecret",
		},
	}
	r := chi.NewRouter()
	r.Post("/api/v1/media/upload", h.UploadMedia)
	r.Get("/api/v1/media/{id}", h.GetMedia)

	orgA := auth.Identity{UserID: "u1", OrganizationID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", Role: "agent"}
	pdfBytes := []byte("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF")
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "quote.pdf")
	_, _ = fw.Write(pdfBytes)
	_ = mw.Close()

	req := withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/media/upload", &buf), orgA)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 on minio upload, got %d: %s", rec.Code, rec.Body.String())
	}
	var upResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &upResp)
	mediaURL, _ := upResp["url"].(string)

	getReq := withIdentity(httptest.NewRequest(http.MethodGet, mediaURL, nil), orgA)
	getRec := httptest.NewRecorder()
	r.ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusOK || !bytes.Equal(getRec.Body.Bytes(), pdfBytes) {
		t.Fatalf("expected 200 and matching pdf bytes from minio proxy, got %d", getRec.Code)
	}
}

func connectTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgres://postgres@127.0.0.1:5432/crm_dev?sslmode=disable"
	}
	pool, err := db.Connect(context.Background(), dbURL)
	if err != nil {
		t.Skipf("postgres not reachable: %v", err)
	}
	return pool
}

func TestInboxCASClaimAndTransferRoundRobin(t *testing.T) {
	pool := connectTestDB(t)
	defer pool.Close()
	ctx := context.Background()

	var orgID, uAgent1, uAgent2, uViewer, contactID, convID string
	_ = pool.QueryRow(ctx, `INSERT INTO organizations (name, slug) VALUES ('Inbox Test', 'inbox-' || substr(md5(random()::text),1,6)) RETURNING id`).Scan(&orgID)
	defer pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, orgID)

	_ = pool.QueryRow(ctx, `INSERT INTO users (email, password_hash, full_name) VALUES ('a1-'||substr(md5(random()::text),1,6)||'@t.com', 'x', 'Agent 1') RETURNING id`).Scan(&uAgent1)
	_ = pool.QueryRow(ctx, `INSERT INTO users (email, password_hash, full_name) VALUES ('a2-'||substr(md5(random()::text),1,6)||'@t.com', 'x', 'Agent 2') RETURNING id`).Scan(&uAgent2)
	_ = pool.QueryRow(ctx, `INSERT INTO users (email, password_hash, full_name) VALUES ('vw-'||substr(md5(random()::text),1,6)||'@t.com', 'x', 'Viewer') RETURNING id`).Scan(&uViewer)
	defer pool.Exec(ctx, `DELETE FROM users WHERE id IN ($1,$2,$3)`, uAgent1, uAgent2, uViewer)

	_, _ = pool.Exec(ctx, `INSERT INTO user_organizations (user_id, organization_id, role, is_available, max_concurrent_chats) VALUES ($1,$2,'agent',true,1)`, uAgent1, orgID)
	_, _ = pool.Exec(ctx, `INSERT INTO user_organizations (user_id, organization_id, role, is_available, max_concurrent_chats) VALUES ($1,$2,'agent',true,1)`, uAgent2, orgID)
	_, _ = pool.Exec(ctx, `INSERT INTO user_organizations (user_id, organization_id, role, is_available, max_concurrent_chats) VALUES ($1,$2,'viewer',true,5)`, uViewer, orgID)

	_ = pool.QueryRow(ctx, `INSERT INTO contacts (organization_id, name, phone_number) VALUES ($1, 'Lead 1', '+5511999991111') RETURNING id`, orgID).Scan(&contactID)
	_ = pool.QueryRow(ctx, `INSERT INTO conversations (organization_id, contact_id, status) VALUES ($1, $2, 'open') RETURNING id`, orgID, contactID).Scan(&convID)

	h := &inbox.Handler{Pool: pool}
	r := chi.NewRouter()
	r.Post("/api/v1/conversations/{id}/claim", h.ClaimConversation)
	r.Post("/api/v1/conversations/{id}/transfer", h.TransferConversation)

	idA1 := auth.Identity{UserID: uAgent1, OrganizationID: orgID, Role: "agent"}

	// 1. Claim with expected_revision = 1 -> 200, rev becomes 2
	rec := httptest.NewRecorder()
	req := withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/conversations/"+convID+"/claim", strings.NewReader(`{"expected_revision":1}`)), idA1)
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 claim, got %d: %s", rec.Code, rec.Body.String())
	}

	// 2. Stale claim with expected_revision = 1 -> 409 conflict with current_revision = 2
	rec2 := httptest.NewRecorder()
	req2 := withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/conversations/"+convID+"/claim", strings.NewReader(`{"expected_revision":1}`)), idA1)
	r.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusConflict {
		t.Fatalf("expected 409 conflict, got %d: %s", rec2.Code, rec2.Body.String())
	}

	// 3. Transfer to viewer -> 400
	rec3 := httptest.NewRecorder()
	req3 := withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/conversations/"+convID+"/transfer", strings.NewReader(`{"target_user_id":"`+uViewer+`","expected_revision":2}`)), idA1)
	r.ServeHTTP(rec3, req3)
	if rec3.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 transferring to viewer, got %d", rec3.Code)
	}

	// 4. Auto-route should pick uAgent2 because uAgent1 already has 1/1 claimed chat
	rec4 := httptest.NewRecorder()
	req4 := withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/conversations/"+convID+"/transfer", strings.NewReader(`{"auto_route":true,"expected_revision":2}`)), idA1)
	r.ServeHTTP(rec4, req4)
	if rec4.Code != http.StatusOK {
		t.Fatalf("expected 200 auto-route, got %d: %s", rec4.Code, rec4.Body.String())
	}
	var trResp map[string]any
	_ = json.Unmarshal(rec4.Body.Bytes(), &trResp)
	if trResp["assigned_to"] != uAgent2 {
		t.Fatalf("expected auto-route to assign %s, got %v", uAgent2, trResp["assigned_to"])
	}
}

func TestSendMessageAntiBanAndNotesAndTemplates(t *testing.T) {
	pool := connectTestDB(t)
	defer pool.Close()
	ctx := context.Background()

	var orgID, userID, sessID, contactID, convID string
	_ = pool.QueryRow(ctx, `INSERT INTO organizations (name, slug) VALUES ('Msg Test', 'msg-' || substr(md5(random()::text),1,6)) RETURNING id`).Scan(&orgID)
	defer pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, orgID)
	_ = pool.QueryRow(ctx, `INSERT INTO users (email, password_hash, full_name) VALUES ('m-'||substr(md5(random()::text),1,6)||'@t.com', 'x', 'Agent') RETURNING id`).Scan(&userID)
	defer pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID)

	_ = pool.QueryRow(ctx, `
		INSERT INTO channel_sessions (organization_id, session_name, provider, webhook_secret, warmup_daily_limit, business_hours)
		VALUES ($1, 'sess-1', 'evolution_go', 'sec', 10, '{"start":"00:00","end":"23:59","timezone":"UTC"}') RETURNING id
	`, orgID).Scan(&sessID)
	_ = pool.QueryRow(ctx, `INSERT INTO contacts (organization_id, name, phone_number, is_blocked) VALUES ($1, 'Bob', '+5511999992222', true) RETURNING id`, orgID).Scan(&contactID)
	_ = pool.QueryRow(ctx, `INSERT INTO conversations (organization_id, contact_id, channel_session_id, status, last_message_preview) VALUES ($1, $2, $3, 'claimed', 'initial') RETURNING id`, orgID, contactID, sessID).Scan(&convID)

	evo := &mockEvolution{}
	th := &mockThrottle{allow: true}
	h := &inbox.Handler{Pool: pool, Evolution: evo, Throttle: th}

	r := chi.NewRouter()
	r.Post("/api/v1/conversations/{id}/messages", h.SendMessage)
	r.Post("/api/v1/templates", h.CreateTemplate)
	r.Patch("/api/v1/templates/{id}", h.UpdateTemplate)
	r.Delete("/api/v1/templates/{id}", h.DeleteTemplate)

	id := auth.Identity{UserID: userID, OrganizationID: orgID, Role: "agent"}

	// 1. Blocked contact -> 422
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/conversations/"+convID+"/messages", strings.NewReader(`{"body":"hi"}`)), id))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for blocked contact, got %d", rec.Code)
	}

	// 2. Internal note bypasses STOP, 24h window, hours, throttle, does not call Evolution, does not overwrite preview
	recNote := httptest.NewRecorder()
	r.ServeHTTP(recNote, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/conversations/"+convID+"/messages", strings.NewReader(`{"body":"secret note","content_type":"note"}`)), id))
	if recNote.Code != http.StatusCreated {
		t.Fatalf("expected 201 for internal note, got %d: %s", recNote.Code, recNote.Body.String())
	}
	if len(evo.calls) != 0 {
		t.Fatalf("internal note must not send via Evolution")
	}
	var preview string
	_ = pool.QueryRow(ctx, `SELECT last_message_preview FROM conversations WHERE id=$1`, convID).Scan(&preview)
	if preview != "initial" {
		t.Fatalf("internal note must not overwrite last_message_preview, got %q", preview)
	}

	// 3. Unblock contact, but last_inbound_at is NULL -> 422 WINDOW_24H_EXPIRED
	_, _ = pool.Exec(ctx, `UPDATE contacts SET is_blocked=false WHERE id=$1`, contactID)
	recWin := httptest.NewRecorder()
	r.ServeHTTP(recWin, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/conversations/"+convID+"/messages", strings.NewReader(`{"body":"hello"}`)), id))
	if recWin.Code != http.StatusUnprocessableEntity || !strings.Contains(recWin.Body.String(), "WINDOW_24H_EXPIRED") {
		t.Fatalf("expected 422 WINDOW_24H_EXPIRED, got %d: %s", recWin.Code, recWin.Body.String())
	}

	// 4. Set recent last_inbound_at, but throttle denies -> 429
	_, _ = pool.Exec(ctx, `UPDATE conversations SET last_inbound_at=now() WHERE id=$1`, convID)
	th.allow = false
	recTh := httptest.NewRecorder()
	r.ServeHTTP(recTh, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/conversations/"+convID+"/messages", strings.NewReader(`{"body":"hello"}`)), id))
	if recTh.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 throttled, got %d: %s", recTh.Code, recTh.Body.String())
	}

	// 5. Throttle allows + media_url -> 201
	th.allow = true
	recOK := httptest.NewRecorder()
	r.ServeHTTP(recOK, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/conversations/"+convID+"/messages", strings.NewReader(`{"body":"hello","media_url":"/api/v1/media/123"}`)), id))
	if recOK.Code != http.StatusCreated || len(evo.calls) != 1 {
		t.Fatalf("expected 201 and 1 evolution call, got %d (calls=%d)", recOK.Code, len(evo.calls))
	}

	// 6. Templates Create -> Patch -> Delete
	recT := httptest.NewRecorder()
	r.ServeHTTP(recT, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/templates", strings.NewReader(`{"shortcut":"/hi","title":"Hi","body":"Hello!"}`)), id))
	if recT.Code != http.StatusCreated {
		t.Fatalf("expected 201 create template, got %d", recT.Code)
	}
	var tResp map[string]any
	_ = json.Unmarshal(recT.Body.Bytes(), &tResp)
	tid, _ := tResp["id"].(string)

	recTP := httptest.NewRecorder()
	r.ServeHTTP(recTP, withIdentity(httptest.NewRequest(http.MethodPatch, "/api/v1/templates/"+tid, strings.NewReader(`{"title":"Updated"}`)), id))
	if recTP.Code != http.StatusOK {
		t.Fatalf("expected 200 patch template, got %d", recTP.Code)
	}

	recTD := httptest.NewRecorder()
	r.ServeHTTP(recTD, withIdentity(httptest.NewRequest(http.MethodDelete, "/api/v1/templates/"+tid, nil), id))
	if recTD.Code != http.StatusOK {
		t.Fatalf("expected 200 delete template, got %d", recTD.Code)
	}
}
