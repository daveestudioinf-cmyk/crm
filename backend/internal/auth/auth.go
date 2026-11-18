package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/httpx"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

type ctxKey string

const IdentityKey ctxKey = "auth_identity"

type Identity struct {
	UserID          string
	OrganizationID  string
	Role            string
	IsPlatformAdmin bool
	SupportSessID   string
	SupportMode     string
	RemoteIP        string
	AuthType        string // "jwt" or "api_token"
}

type Claims struct {
	UserID          string `json:"uid"`
	OrganizationID  string `json:"oid"`
	Role            string `json:"role"`
	IsPlatformAdmin bool   `json:"pa"`
	MfaPending      bool   `json:"mfa_pending,omitempty"`
	jwt.RegisteredClaims
}

var roleRank = map[string]int{
	"viewer":  1,
	"agent":   2,
	"manager": 3,
	"admin":   4,
}

func HasRole(actual, minRequired string) bool {
	return roleRank[actual] >= roleRank[minRequired]
}

func FromContext(ctx context.Context) (Identity, bool) {
	id, ok := ctx.Value(IdentityKey).(Identity)
	return id, ok
}

func HashPassword(pw string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost)
	return string(b), err
}

func CheckPassword(hash, pw string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pw)) == nil
}

func HashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

func RandomToken(nBytes int) (string, error) {
	b := make([]byte, nBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func IssueAccessToken(secret string, id Identity, ttl time.Duration, mfaPending bool) (string, error) {
	claims := Claims{
		UserID:          id.UserID,
		OrganizationID:  id.OrganizationID,
		Role:            id.Role,
		IsPlatformAdmin: id.IsPlatformAdmin,
		MfaPending:      mfaPending,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(ttl)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return tok.SignedString([]byte(secret))
}

func ParseToken(secret, tokenStr string) (*Claims, error) {
	tok, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (any, error) {
		return []byte(secret), nil
	})
	if err != nil || !tok.Valid {
		return nil, err
	}
	claims, ok := tok.Claims.(*Claims)
	if !ok {
		return nil, jwt.ErrTokenInvalidClaims
	}
	return claims, nil
}

func extractRemoteIP(r *http.Request) string {
	addr := strings.TrimSpace(r.RemoteAddr)
	if addr == "" {
		return ""
	}
	if host, _, err := net.SplitHostPort(addr); err == nil {
		return host
	}
	return addr
}

type Middleware struct {
	Pool      *pgxpool.Pool
	JWTSecret string
}

// Authenticate resolves base identity from JWT or api_token (crm_*) and extracts RemoteIP.
// It does not check tenant suspension or X-Support-Session-ID.
func (m *Middleware) Authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		tokenStr := ""
		if strings.HasPrefix(authHeader, "Bearer ") {
			tokenStr = strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
		} else if q := r.URL.Query().Get("token"); q != "" {
			// For SSE EventSource which cannot set Authorization headers cleanly
			tokenStr = q
		}

		if tokenStr == "" {
			httpx.Error(w, http.StatusUnauthorized, "missing authorization token")
			return
		}

		remoteIP := extractRemoteIP(r)

		// Check if API Token (prefixed with crm_)
		if strings.HasPrefix(tokenStr, "crm_") {
			hash := HashToken(tokenStr)
			var id Identity
			var role string
			err := m.Pool.QueryRow(r.Context(), `
				SELECT t.user_id, t.organization_id, uo.role, u.is_platform_admin
				FROM api_tokens t
				JOIN users u ON u.id = t.user_id
				JOIN user_organizations uo ON uo.user_id = t.user_id AND uo.organization_id = t.organization_id
				WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())
			`, hash).Scan(&id.UserID, &id.OrganizationID, &role, &id.IsPlatformAdmin)
			if err != nil {
				httpx.Error(w, http.StatusUnauthorized, "invalid api token")
				return
			}
			id.Role = role
			id.AuthType = "api_token"
			id.RemoteIP = remoteIP
			_, _ = m.Pool.Exec(r.Context(), `UPDATE api_tokens SET last_used_at = now() WHERE token_hash = $1`, hash)
			ctx := context.WithValue(r.Context(), IdentityKey, id)
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}

		claims, err := ParseToken(m.JWTSecret, tokenStr)
		if err != nil || claims.MfaPending {
			httpx.Error(w, http.StatusUnauthorized, "invalid or expired token")
			return
		}

		id := Identity{
			UserID:          claims.UserID,
			OrganizationID:  claims.OrganizationID,
			Role:            claims.Role,
			IsPlatformAdmin: claims.IsPlatformAdmin,
			RemoteIP:        remoteIP,
			AuthType:        "jwt",
		}
		ctx := context.WithValue(r.Context(), IdentityKey, id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// RequireTenantAccess enforces tenant isolation, suspension checks, and audited support sessions.
func (m *Middleware) RequireTenantAccess(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, ok := FromContext(r.Context())
		if !ok {
			httpx.Error(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		supportSessID := strings.TrimSpace(r.Header.Get("X-Support-Session-ID"))
		if supportSessID != "" {
			if id.AuthType != "jwt" {
				httpx.Error(w, http.StatusForbidden, "support_session_jwt_only")
				return
			}
			var targetOrgID, mode string
			err := m.Pool.QueryRow(r.Context(), `
				SELECT s.target_organization_id, s.mode
				FROM platform_support_sessions s
				JOIN users u ON u.id = s.admin_user_id
				WHERE s.id = $1 AND s.admin_user_id = $2 AND u.is_platform_admin = true
				  AND s.ended_at IS NULL AND s.expires_at > now()
			`, supportSessID, id.UserID).Scan(&targetOrgID, &mode)
			if err != nil {
				httpx.Error(w, http.StatusForbidden, "support_session_invalid")
				return
			}
			id.OrganizationID = targetOrgID
			id.Role = "admin"
			id.IsPlatformAdmin = true
			id.SupportSessID = supportSessID
			id.SupportMode = mode

			if mode == "support_readonly" &&
				r.Method != http.MethodGet &&
				r.Method != http.MethodHead &&
				r.Method != http.MethodOptions {
				httpx.Error(w, http.StatusForbidden, "support_readonly")
				return
			}

			if mode != "support_readonly" {
				var isSuspended bool
				err := m.Pool.QueryRow(r.Context(), `SELECT is_suspended FROM organizations WHERE id = $1`, id.OrganizationID).Scan(&isSuspended)
				if err != nil || isSuspended {
					httpx.Error(w, http.StatusForbidden, "tenant_suspended")
					return
				}
			}

			action := "support.read"
			if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
				action = "support.write"
			}
			_ = WriteAudit(r.Context(), m.Pool, id, action, "http_request", r.URL.Path, map[string]any{
				"method": r.Method,
				"path":   r.URL.Path,
				"mode":   mode,
			})

			ctx := context.WithValue(r.Context(), IdentityKey, id)
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}

		if id.AuthType == "jwt" {
			if hdrOrg := strings.TrimSpace(r.Header.Get("X-Organization-ID")); hdrOrg != "" && hdrOrg != id.OrganizationID {
				var role string
				err := m.Pool.QueryRow(r.Context(), `
					SELECT role FROM user_organizations WHERE user_id = $1 AND organization_id = $2
				`, id.UserID, hdrOrg).Scan(&role)
				if err == nil {
					id.OrganizationID = hdrOrg
					id.Role = role
				}
			}
		}

		var isSuspended bool
		err := m.Pool.QueryRow(r.Context(), `SELECT is_suspended FROM organizations WHERE id = $1`, id.OrganizationID).Scan(&isSuspended)
		if err != nil || isSuspended {
			httpx.Error(w, http.StatusForbidden, "tenant_suspended")
			return
		}

		ctx := context.WithValue(r.Context(), IdentityKey, id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// RequireAuth composes Authenticate and RequireTenantAccess for tenant routes.
func (m *Middleware) RequireAuth(next http.Handler) http.Handler {
	return m.Authenticate(m.RequireTenantAccess(next))
}

// RequirePlatformAdmin verifies JWT auth and users.is_platform_admin in PostgreSQL for /api/v1/admin/*.
func (m *Middleware) RequirePlatformAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, ok := FromContext(r.Context())
		if !ok {
			httpx.Error(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		if id.AuthType != "jwt" {
			httpx.Error(w, http.StatusForbidden, "platform_admin_jwt_only")
			return
		}
		var isPA bool
		err := m.Pool.QueryRow(r.Context(), `SELECT is_platform_admin FROM users WHERE id = $1`, id.UserID).Scan(&isPA)
		if err != nil || !isPA {
			httpx.Error(w, http.StatusForbidden, "platform_admin_required")
			return
		}
		id.IsPlatformAdmin = true
		ctx := context.WithValue(r.Context(), IdentityKey, id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func RequireRole(minRole string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id, ok := FromContext(r.Context())
			if !ok || !HasRole(id.Role, minRole) {
				httpx.Error(w, http.StatusForbidden, "insufficient role")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func WriteAudit(ctx context.Context, pool *pgxpool.Pool, id Identity, action, resType, resID string, meta any) error {
	_, err := pool.Exec(ctx, `
		INSERT INTO api_audit_log (organization_id, actor_user_id, support_session_id, action, resource_type, resource_id, metadata, ip_address)
		VALUES (NULLIF($1, '')::uuid, NULLIF($2, '')::uuid, NULLIF($3, '')::uuid, $4, $5, $6, $7, NULLIF($8, ''))
	`, id.OrganizationID, id.UserID, id.SupportSessID, action, resType, resID, meta, id.RemoteIP)
	return err
}
