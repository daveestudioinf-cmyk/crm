package auth

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/httpx"
)

func (h *Handler) GetOrganization(w http.ResponseWriter, r *http.Request) {
	id, _ := FromContext(r.Context())
	var orgID, name, slug string
	var settings, branding json.RawMessage
	var isSuspended bool
	err := h.Pool.QueryRow(r.Context(), `
		SELECT id, name, slug, settings, branding, is_suspended
		FROM organizations
		WHERE id = $1
	`, id.OrganizationID).Scan(&orgID, &name, &slug, &settings, &branding, &isSuspended)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "organization not found")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id":           orgID,
		"name":         name,
		"slug":         slug,
		"settings":     json.RawMessage(settings),
		"branding":     json.RawMessage(branding),
		"is_suspended": isSuspended,
	})
}

func (h *Handler) UpdateOrganization(w http.ResponseWriter, r *http.Request) {
	id, _ := FromContext(r.Context())
	var req struct {
		Name     *string         `json:"name"`
		Settings json.RawMessage `json:"settings"`
		Branding json.RawMessage `json:"branding"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}

	var nameArg *string
	if req.Name != nil {
		trimmed := strings.TrimSpace(*req.Name)
		if trimmed == "" {
			httpx.Error(w, http.StatusBadRequest, "name cannot be empty")
			return
		}
		nameArg = &trimmed
	}

	settingsPatch := "{}"
	if len(req.Settings) > 0 && string(req.Settings) != "null" {
		if !json.Valid(req.Settings) {
			httpx.Error(w, http.StatusBadRequest, "invalid settings json")
			return
		}
		settingsPatch = string(req.Settings)
	}

	brandingPatch := "{}"
	if len(req.Branding) > 0 && string(req.Branding) != "null" {
		if !json.Valid(req.Branding) {
			httpx.Error(w, http.StatusBadRequest, "invalid branding json")
			return
		}
		brandingPatch = string(req.Branding)
	}

	var orgID, name, slug string
	var settings, branding json.RawMessage
	var isSuspended bool
	err := h.Pool.QueryRow(r.Context(), `
		UPDATE organizations
		SET name = COALESCE($1, name),
		    settings = settings || $2::jsonb,
		    branding = branding || $3::jsonb,
		    updated_at = now()
		WHERE id = $4
		RETURNING id, name, slug, settings, branding, is_suspended
	`, nameArg, settingsPatch, brandingPatch, id.OrganizationID).Scan(&orgID, &name, &slug, &settings, &branding, &isSuspended)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to update organization")
		return
	}

	_ = WriteAudit(r.Context(), h.Pool, id, "organization.update", "organization", id.OrganizationID, map[string]any{
		"name_updated":     nameArg != nil,
		"settings_updated": settingsPatch != "{}",
		"branding_updated": brandingPatch != "{}",
	})

	httpx.JSON(w, http.StatusOK, map[string]any{
		"id":           orgID,
		"name":         name,
		"slug":         slug,
		"settings":     json.RawMessage(settings),
		"branding":     json.RawMessage(branding),
		"is_suspended": isSuspended,
	})
}
