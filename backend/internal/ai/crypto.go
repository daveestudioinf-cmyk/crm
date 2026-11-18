package ai

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"strings"
)

func deriveAESKey(seed string) []byte {
	sum := sha256.Sum256([]byte(seed))
	return sum[:]
}

// EncryptAPIKey encrypts a plaintext API key using AES-256-GCM.
func EncryptAPIKey(keySeed, plaintext string) (string, error) {
	if strings.TrimSpace(plaintext) == "" {
		return "", errors.New("api key is empty")
	}
	block, err := aes.NewCipher(deriveAESKey(keySeed))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(sealed), nil
}

// DecryptAPIKey decrypts an AES-256-GCM encrypted API key.
func DecryptAPIKey(keySeed, ciphertextB64 string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(ciphertextB64)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(deriveAESKey(keySeed))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	ns := gcm.NonceSize()
	if len(raw) < ns {
		return "", errors.New("ciphertext too short")
	}
	plain, err := gcm.Open(nil, raw[:ns], raw[ns:], nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

// MaskAPIKey returns a safe display mask without exposing the secret.
func MaskAPIKey(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if len(trimmed) <= 8 {
		return "••••"
	}
	return trimmed[:3] + "••••" + trimmed[len(trimmed)-4:]
}
