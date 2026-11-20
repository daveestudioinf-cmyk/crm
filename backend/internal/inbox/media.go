package inbox

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/httpx"
	"github.com/go-chi/chi/v5"
)

const maxMediaUploadBytes = 16 << 20 // 16MB

var allowedMediaTypes = map[string]bool{
	"image/jpeg":      true,
	"image/png":       true,
	"image/gif":       true,
	"image/webp":      true,
	"audio/mpeg":      true,
	"audio/ogg":       true,
	"audio/wav":       true,
	"audio/mp4":       true,
	"audio/webm":      true,
	"video/mp4":       true,
	"video/webm":      true,
	"application/pdf": true,
	"text/plain":      true,
	"application/msword": true,
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": true,
}

var safeMediaIDRe = regexp.MustCompile(`^[a-fA-F0-9-]{8,64}$`)

func (h *Handler) uploadDir() string {
	if h.Cfg.UploadDir != "" {
		return h.Cfg.UploadDir
	}
	return "./uploads"
}

func (h *Handler) minioBucket() string {
	if h.Cfg.MinioBucket != "" {
		return h.Cfg.MinioBucket
	}
	return "crm-media"
}

// UploadMedia handles POST /api/v1/media/upload (multipart "file", max 16MB).
func (h *Handler) UploadMedia(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())

	r.Body = http.MaxBytesReader(w, r.Body, maxMediaUploadBytes+65536)
	if err := r.ParseMultipartForm(maxMediaUploadBytes); err != nil {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "file exceeds 16MB limit or invalid multipart")
		return
	}
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()

	file, header, err := r.FormFile("file")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "file field is required")
		return
	}
	defer file.Close()

	data, err := io.ReadAll(io.LimitReader(file, maxMediaUploadBytes+1))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "failed to read file")
		return
	}
	if int64(len(data)) > maxMediaUploadBytes {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "file exceeds 16MB limit")
		return
	}
	if len(data) == 0 {
		httpx.Error(w, http.StatusBadRequest, "empty file")
		return
	}

	contentType := detectMediaContentType(data, header.Header.Get("Content-Type"), header.Filename)
	if !allowedMediaTypes[contentType] {
		httpx.Error(w, http.StatusUnsupportedMediaType, "unsupported media content type: "+contentType)
		return
	}

	mediaID := newUUIDv4()
	safeName := sanitizeFilename(header.Filename)

	if h.Cfg.MinioEndpoint != "" {
		objectKey := id.OrganizationID + "/" + mediaID
		if err := h.minioPutObject(objectKey, data, contentType, safeName); err != nil {
			httpx.Error(w, http.StatusBadGateway, "media storage upload failed")
			return
		}
	} else {
		orgDir := filepath.Join(h.uploadDir(), id.OrganizationID)
		if err := os.MkdirAll(orgDir, 0o755); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "failed to prepare media directory")
			return
		}
		destPath := filepath.Join(orgDir, mediaID+"_"+safeName)
		if err := os.WriteFile(destPath, data, 0o644); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "failed to write media file")
			return
		}
	}

	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id":           mediaID,
		"url":          "/api/v1/media/" + mediaID,
		"content_type": contentType,
		"filename":     safeName,
		"size":         len(data),
	})
}

// GetMedia handles GET /api/v1/media/{id} with strict organization_id tenant isolation.
func (h *Handler) GetMedia(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	mediaID := chi.URLParam(r, "id")
	if !safeMediaIDRe.MatchString(mediaID) {
		httpx.Error(w, http.StatusBadRequest, "invalid media id")
		return
	}

	if h.Cfg.MinioEndpoint != "" {
		objectKey := id.OrganizationID + "/" + mediaID
		data, contentType, filename, status, err := h.minioGetObject(objectKey)
		if err != nil {
			if status == http.StatusNotFound {
				httpx.Error(w, http.StatusNotFound, "media not found")
				return
			}
			httpx.Error(w, http.StatusBadGateway, "media storage fetch failed")
			return
		}
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		w.Header().Set("Content-Type", contentType)
		if filename != "" {
			w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s"`, sanitizeFilename(filename)))
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
		return
	}

	orgDir := filepath.Join(h.uploadDir(), id.OrganizationID)
	matches, err := filepath.Glob(filepath.Join(orgDir, mediaID+"_*"))
	if err != nil || len(matches) == 0 {
		httpx.Error(w, http.StatusNotFound, "media not found")
		return
	}
	filePath := matches[0]
	data, err := os.ReadFile(filePath)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "media not found")
		return
	}

	base := filepath.Base(filePath)
	filename := strings.TrimPrefix(base, mediaID+"_")
	contentType := detectMediaContentType(data, "", filename)

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s"`, sanitizeFilename(filename)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func detectMediaContentType(data []byte, declared, filename string) string {
	sniffed := http.DetectContentType(data)
	if idx := strings.Index(sniffed, ";"); idx != -1 {
		sniffed = strings.TrimSpace(sniffed[:idx])
	}
	if idx := strings.Index(declared, ";"); idx != -1 {
		declared = strings.TrimSpace(declared[:idx])
	}

	// Prefer declared or extension type for formats that sniff as application/octet-stream or text/plain
	if sniffed == "application/octet-stream" || sniffed == "application/zip" {
		if extType := mime.TypeByExtension(strings.ToLower(filepath.Ext(filename))); extType != "" {
			if idx := strings.Index(extType, ";"); idx != -1 {
				extType = strings.TrimSpace(extType[:idx])
			}
			if allowedMediaTypes[extType] {
				return extType
			}
		}
		if allowedMediaTypes[declared] {
			return declared
		}
	}
	if sniffed == "text/plain" && declared != "" && allowedMediaTypes[declared] && strings.HasPrefix(declared, "text/") {
		return declared
	}
	return sniffed
}

func sanitizeFilename(name string) string {
	base := filepath.Base(strings.TrimSpace(name))
	if base == "" || base == "." || base == ".." || base == "/" {
		return "file"
	}
	var b strings.Builder
	for _, r := range base {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '-' || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	res := b.String()
	if res == "" {
		return "file"
	}
	return res
}

func newUUIDv4() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func (h *Handler) minioPutObject(objectKey string, data []byte, contentType, filename string) error {
	endpoint := strings.TrimRight(h.Cfg.MinioEndpoint, "/")
	if !strings.HasPrefix(endpoint, "http://") && !strings.HasPrefix(endpoint, "https://") {
		endpoint = "http://" + endpoint
	}
	targetURL := fmt.Sprintf("%s/%s/%s", endpoint, h.minioBucket(), objectKey)
	req, err := http.NewRequest(http.MethodPut, targetURL, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("X-Amz-Meta-Filename", filename)
	signSigV4(req, data, h.Cfg.MinioAccessKey, h.Cfg.MinioSecretKey, "us-east-1", "s3", time.Now().UTC())

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("minio put status %d", resp.StatusCode)
	}
	return nil
}

func (h *Handler) minioGetObject(objectKey string) ([]byte, string, string, int, error) {
	endpoint := strings.TrimRight(h.Cfg.MinioEndpoint, "/")
	if !strings.HasPrefix(endpoint, "http://") && !strings.HasPrefix(endpoint, "https://") {
		endpoint = "http://" + endpoint
	}
	targetURL := fmt.Sprintf("%s/%s/%s", endpoint, h.minioBucket(), objectKey)
	req, err := http.NewRequest(http.MethodGet, targetURL, nil)
	if err != nil {
		return nil, "", "", http.StatusInternalServerError, err
	}
	signSigV4(req, nil, h.Cfg.MinioAccessKey, h.Cfg.MinioSecretKey, "us-east-1", "s3", time.Now().UTC())

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", "", http.StatusBadGateway, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", "", resp.StatusCode, fmt.Errorf("minio get status %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxMediaUploadBytes+1))
	if err != nil {
		return nil, "", "", http.StatusBadGateway, err
	}
	return data, resp.Header.Get("Content-Type"), resp.Header.Get("X-Amz-Meta-Filename"), http.StatusOK, nil
}

func signSigV4(req *http.Request, payload []byte, accessKey, secretKey, region, service string, now time.Time) {
	u, _ := url.Parse(req.URL.String())
	host := u.Host
	amzDate := now.UTC().Format("20060102T150405Z")
	dateStamp := now.UTC().Format("20060102")

	sum := sha256.Sum256(payload)
	payloadHash := hex.EncodeToString(sum[:])

	req.Header.Set("Host", host)
	req.Header.Set("X-Amz-Date", amzDate)
	req.Header.Set("X-Amz-Content-Sha256", payloadHash)

	if accessKey == "" || secretKey == "" {
		return
	}

	canonicalURI := u.EscapedPath()
	if canonicalURI == "" {
		canonicalURI = "/"
	}
	canonicalHeaders := fmt.Sprintf("host:%s\nx-amz-content-sha256:%s\nx-amz-date:%s\n", host, payloadHash, amzDate)
	signedHeaders := "host;x-amz-content-sha256;x-amz-date"

	canonicalRequest := strings.Join([]string{
		req.Method,
		canonicalURI,
		u.RawQuery,
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	}, "\n")

	crHash := sha256.Sum256([]byte(canonicalRequest))
	scope := fmt.Sprintf("%s/%s/%s/aws4_request", dateStamp, region, service)
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		hex.EncodeToString(crHash[:]),
	}, "\n")

	kDate := hmacSHA256([]byte("AWS4"+secretKey), dateStamp)
	kRegion := hmacSHA256(kDate, region)
	kService := hmacSHA256(kRegion, service)
	kSigning := hmacSHA256(kService, "aws4_request")
	signature := hex.EncodeToString(hmacSHA256(kSigning, stringToSign))

	authHeader := fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s", accessKey, scope, signedHeaders, signature)
	req.Header.Set("Authorization", authHeader)
}

func hmacSHA256(key []byte, data string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(data))
	return mac.Sum(nil)
}
