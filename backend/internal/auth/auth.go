package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
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

type Middleware struct {
	Pool      *pgxpool.Pool
	JWTSecret string
}

func (m *Middleware) RequireAuth(next http.Handler) http.Handler {
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

		orgID := claims.OrganizationID
		if hdrOrg := r.Header.Get("X-Organization-ID"); hdrOrg != "" && hdrOrg != orgID {
			// Verify user actually belongs to requested org
			var role string
			err := m.Pool.QueryRow(r.Context(), `
				SELECT role FROM user_organizations WHERE user_id = $1 AND organization_id = $2
			`, claims.UserID, hdrOrg).Scan(&role)
			if err == nil {
				orgID = hdrOrg
				claims.Role = role
			}
		}

		id := Identity{
			UserID:          claims.UserID,
			OrganizationID:  orgID,
			Role:            claims.Role,
			IsPlatformAdmin: claims.IsPlatformAdmin,
			AuthType:        "jwt",
		}
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

func WriteAudit(ctx context.Context, pool *pgxpool.Pool, id Identity, action, resType, resID string, meta any) {
	_, _ = pool.Exec(ctx, `
		INSERT INTO api_audit_log (organization_id, actor_user_id, action, resource_type, resource_id, metadata)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, id.OrganizationID, id.UserID, action, resType, resID, meta)
}
