package auth

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/httpx"
)

func extractPipelineVocabulary(settings json.RawMessage) map[string]any {
	defaults := map[string]any{"deal": "Negocio", "deals": "Negocios", "stage": "Etapa"}
	var m map[string]any
	if err := json.Unmarshal(settings, &m); err == nil {
		if pv, ok := m["pipeline_vocabulary"].(map[string]any); ok && len(pv) > 0 {
			return pv
		}
	}
	return defaults
}

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
		"id":                  orgID,
		"name":                name,
		"slug":                slug,
		"settings":            json.RawMessage(settings),
		"branding":            json.RawMessage(branding),
		"is_suspended":        isSuspended,
		"pipeline_vocabulary": extractPipelineVocabulary(settings),
	})
}

func (h *Handler) UpdateOrganization(w http.ResponseWriter, r *http.Request) {
	id, _ := FromContext(r.Context())
	var req struct {
		Name               *string         `json:"name"`
		Settings           json.RawMessage `json:"settings"`
		Branding           json.RawMessage `json:"branding"`
		PipelineVocabulary json.RawMessage `json:"pipeline_vocabulary"`
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

	settingsMap := map[string]any{}
	if len(req.Settings) > 0 && string(req.Settings) != "null" {
		if !json.Valid(req.Settings) || json.Unmarshal(req.Settings, &settingsMap) != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid settings json")
			return
		}
	}
	if len(req.PipelineVocabulary) > 0 && string(req.PipelineVocabulary) != "null" {
		var pv map[string]any
		if !json.Valid(req.PipelineVocabulary) || json.Unmarshal(req.PipelineVocabulary, &pv) != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid pipeline_vocabulary json")
			return
		}
		settingsMap["pipeline_vocabulary"] = pv
	}
	settingsPatchBytes, _ := json.Marshal(settingsMap)
	settingsPatch := string(settingsPatchBytes)

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

	if pv, ok := settingsMap["pipeline_vocabulary"].(map[string]any); ok && len(pv) > 0 {
		if pvBytes, err := json.Marshal(pv); err == nil {
			_, _ = h.Pool.Exec(r.Context(), `
				UPDATE crm_pipelines
				SET vocabulary = vocabulary || $1::jsonb
				WHERE organization_id = $2
			`, string(pvBytes), id.OrganizationID)
		}
	}

	_ = WriteAudit(r.Context(), h.Pool, id, "organization.update", "organization", id.OrganizationID, map[string]any{
		"name_updated":     nameArg != nil,
		"settings_updated": settingsPatch != "{}",
		"branding_updated": brandingPatch != "{}",
	})

	httpx.JSON(w, http.StatusOK, map[string]any{
		"id":                  orgID,
		"name":                name,
		"slug":                slug,
		"settings":            json.RawMessage(settings),
		"branding":            json.RawMessage(branding),
		"is_suspended":        isSuspended,
		"pipeline_vocabulary": extractPipelineVocabulary(settings),
	})
}
