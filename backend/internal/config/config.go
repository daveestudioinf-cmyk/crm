package config

import (
	"os"
)

type Config struct {
	Port            string
	DatabaseURL     string
	RedisURL        string
	JWTSecret       string
	FrontendOrigin  string
	WAHAUrl         string
	EvolutionURL    string
	EvolutionAPIKey string
	PublicAPIURL    string
	OpenAIKey       string
	AIEncryptionKey string
	MinioEndpoint   string
	MinioBucket     string
	MinioAccessKey  string
	MinioSecretKey  string
	UploadDir       string
	SecureCookies   bool
}

func Load() Config {
	jwtSecret := getEnv("JWT_SECRET", "dev-secret-change-in-production-32bytes!")
	return Config{
		Port:            getEnv("PORT", "8080"),
		DatabaseURL:     getEnv("DATABASE_URL", "postgres://postgres@127.0.0.1:5432/crm_dev?sslmode=disable"),
		RedisURL:        getEnv("REDIS_URL", ""),
		JWTSecret:       jwtSecret,
		FrontendOrigin:  getEnv("FRONTEND_ORIGIN", "http://localhost:5173"),
		WAHAUrl:         getEnv("WAHA_URL", ""),
		EvolutionURL:    getEnv("EVOLUTION_API_URL", ""),
		EvolutionAPIKey: getEnv("EVOLUTION_API_KEY", ""),
		PublicAPIURL:    getEnv("PUBLIC_API_URL", "http://api:8080"),
		OpenAIKey:       getEnv("OPENAI_API_KEY", ""),
		AIEncryptionKey: getEnv("AI_ENCRYPTION_KEY", jwtSecret),
		MinioEndpoint:   getEnv("MINIO_ENDPOINT", ""),
		MinioBucket:     getEnv("MINIO_BUCKET", "crm-media"),
		MinioAccessKey:  getEnv("MINIO_ACCESS_KEY", ""),
		MinioSecretKey:  getEnv("MINIO_SECRET_KEY", ""),
		UploadDir:       getEnv("UPLOAD_DIR", "./uploads"),
		SecureCookies:   getEnv("SECURE_COOKIES", "false") == "true",
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
