package whatsapp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type EvolutionClient struct {
	BaseURL string
	APIKey  string
	HTTP    *http.Client
}

func NewEvolutionClient(baseURL, apiKey string) *EvolutionClient {
	if strings.TrimSpace(baseURL) == "" {
		return nil
	}
	return &EvolutionClient{
		BaseURL: strings.TrimRight(baseURL, "/"),
		APIKey:  apiKey,
		HTTP:    &http.Client{Timeout: 15 * time.Second},
	}
}

func (c *EvolutionClient) do(ctx context.Context, method, path string, body any, out any) error {
	var rdr *bytes.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.APIKey != "" {
		req.Header.Set("apikey", c.APIKey)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("evolution status %d", resp.StatusCode)
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

func (c *EvolutionClient) CreateInstance(ctx context.Context, instanceName, webhookURL string) error {
	payload := map[string]any{
		"instanceName": instanceName,
		"qrcode":       true,
		"webhook": map[string]any{
			"url":      webhookURL,
			"byEvents": false,
			"events":   []string{"MESSAGES_UPSERT", "CONNECTION_UPDATE", "QRCODE_UPDATED"},
		},
	}
	return c.do(ctx, http.MethodPost, "/instance/create", payload, nil)
}

func (c *EvolutionClient) ConnectQR(ctx context.Context, instanceName string) (base64QR string, code string, err error) {
	var res struct {
		Base64 string `json:"base64"`
		Code   string `json:"code"`
		QRCode struct {
			Base64 string `json:"base64"`
			Code   string `json:"code"`
		} `json:"qrcode"`
	}
	if err := c.do(ctx, http.MethodGet, "/instance/connect/"+instanceName, nil, &res); err != nil {
		return "", "", err
	}
	b64 := res.Base64
	if b64 == "" {
		b64 = res.QRCode.Base64
	}
	cd := res.Code
	if cd == "" {
		cd = res.QRCode.Code
	}
	return b64, cd, nil
}

func (c *EvolutionClient) SendText(ctx context.Context, instanceName, phoneNumber, text string) error {
	cleanPhone := strings.TrimPrefix(strings.TrimSpace(phoneNumber), "+")
	payload := map[string]any{
		"number": cleanPhone,
		"text":   text,
	}
	return c.do(ctx, http.MethodPost, "/message/sendText/"+instanceName, payload, nil)
}
