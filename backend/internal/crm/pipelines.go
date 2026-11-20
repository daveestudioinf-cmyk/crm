package crm

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/httpx"
	"github.com/go-chi/chi/v5"
)

func (h *Handler) ListPipelines(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `
		SELECT id, name, pipeline_type, vocabulary, fields_schema, is_default, created_at
		FROM crm_pipelines WHERE organization_id = $1 ORDER BY is_default DESC, created_at ASC
	`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var pid, name, ptype string
		var vocab map[string]any
		var fieldsSchema []any
		var isDef bool
		var createdAt any
		_ = rows.Scan(&pid, &name, &ptype, &vocab, &fieldsSchema, &isDef, &createdAt)
		if vocab == nil {
			vocab = map[string]any{"deal": "Lead", "deals": "Leads", "stage": "Etapa"}
		}
		if fieldsSchema == nil {
			fieldsSchema = []any{}
		}

		sRows, _ := h.Pool.Query(r.Context(), `
			SELECT id, name, position, color, is_won, is_lost, requires_human
			FROM crm_stages WHERE pipeline_id = $1 AND organization_id = $2 ORDER BY position ASC
		`, pid, id.OrganizationID)
		stages := []map[string]any{}
		if sRows != nil {
			for sRows.Next() {
				var sid, sname, color string
				var pos float64
				var won, lost, reqHuman bool
				_ = sRows.Scan(&sid, &sname, &pos, &color, &won, &lost, &reqHuman)
				stages = append(stages, map[string]any{
					"id": sid, "name": sname, "position": pos, "color": color,
					"is_won": won, "is_lost": lost, "requires_human": reqHuman,
				})
			}
			sRows.Close()
		}
		out = append(out, map[string]any{
			"id": pid, "name": name, "pipeline_type": ptype, "vocabulary": vocab,
			"fields_schema": fieldsSchema, "is_default": isDef, "created_at": createdAt, "stages": stages,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) CreatePipeline(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		Name         string         `json:"name"`
		PipelineType string         `json:"pipeline_type"`
		Vocabulary   map[string]any `json:"vocabulary"`
		FieldsSchema []any          `json:"fields_schema"`
		IsDefault    bool           `json:"is_default"`
		Stages       []struct {
			Name          string   `json:"name"`
			Position      *float64 `json:"position"`
			Color         string   `json:"color"`
			IsWon         bool     `json:"is_won"`
			IsLost        bool     `json:"is_lost"`
			RequiresHuman bool     `json:"requires_human"`
		} `json:"stages"`
	}
	if err := httpx.Decode(r, &req); err != nil || strings.TrimSpace(req.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "name is required")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.PipelineType == "" {
		req.PipelineType = "sales"
	}
	if req.PipelineType != "sales" && req.PipelineType != "support" && req.PipelineType != "custom" {
		httpx.Error(w, http.StatusBadRequest, "invalid pipeline_type")
		return
	}
	if req.Vocabulary == nil {
		if req.PipelineType == "support" {
			req.Vocabulary = map[string]any{"deal": "Ticket", "deals": "Tickets", "stage": "Estado"}
		} else {
			req.Vocabulary = map[string]any{"deal": "Lead", "deals": "Leads", "stage": "Etapa"}
		}
	}
	if req.FieldsSchema == nil {
		req.FieldsSchema = []any{}
	}

	vocabJSON, _ := json.Marshal(req.Vocabulary)
	fieldsJSON, _ := json.Marshal(req.FieldsSchema)

	tx, err := h.Pool.Begin(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer tx.Rollback(r.Context())

	if req.IsDefault {
		if _, err := tx.Exec(r.Context(), `UPDATE crm_pipelines SET is_default = false, updated_at = now() WHERE organization_id = $1`, id.OrganizationID); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "failed to clear default pipeline")
			return
		}
	}

	var pid string
	err = tx.QueryRow(r.Context(), `
		INSERT INTO crm_pipelines (organization_id, name, pipeline_type, vocabulary, fields_schema, is_default)
		VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6) RETURNING id
	`, id.OrganizationID, req.Name, req.PipelineType, string(vocabJSON), string(fieldsJSON), req.IsDefault).Scan(&pid)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to create pipeline")
		return
	}

	type stageSeed struct {
		Name          string
		Position      float64
		Color         string
		IsWon         bool
		IsLost        bool
		RequiresHuman bool
	}
	var seeds []stageSeed
	if len(req.Stages) > 0 {
		for i, s := range req.Stages {
			if strings.TrimSpace(s.Name) == "" {
				continue
			}
			pos := float64((i + 1) * 1000)
			if s.Position != nil {
				pos = *s.Position
			}
			col := strings.TrimSpace(s.Color)
			if col == "" {
				col = "#64748b"
			}
			seeds = append(seeds, stageSeed{
				Name: strings.TrimSpace(s.Name), Position: pos, Color: col,
				IsWon: s.IsWon, IsLost: s.IsLost, RequiresHuman: s.RequiresHuman,
			})
		}
	} else if req.PipelineType == "support" {
		seeds = []stageSeed{
			{Name: "Nuevo", Position: 1000, Color: "#0f766e"},
			{Name: "En Progreso", Position: 2000, Color: "#0284c7", RequiresHuman: true},
			{Name: "Resuelto", Position: 3000, Color: "#10b981", IsWon: true},
		}
	} else {
		seeds = []stageSeed{
			{Name: "Nuevo", Position: 1000, Color: "#0f766e"},
			{Name: "Calificado", Position: 2000, Color: "#0284c7"},
			{Name: "Propuesta", Position: 3000, Color: "#d97706"},
			{Name: "Ganado", Position: 4000, Color: "#10b981", IsWon: true},
			{Name: "Perdido", Position: 5000, Color: "#ef4444", IsLost: true},
		}
	}

	createdStages := []map[string]any{}
	for _, s := range seeds {
		var sid string
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO crm_stages (organization_id, pipeline_id, name, position, color, is_won, is_lost, requires_human)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
		`, id.OrganizationID, pid, s.Name, s.Position, s.Color, s.IsWon, s.IsLost, s.RequiresHuman).Scan(&sid); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "failed to create stages")
			return
		}
		createdStages = append(createdStages, map[string]any{
			"id": sid, "name": s.Name, "position": s.Position, "color": s.Color,
			"is_won": s.IsWon, "is_lost": s.IsLost, "requires_human": s.RequiresHuman,
		})
	}

	if err := tx.Commit(r.Context()); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "commit failed")
		return
	}

	_ = auth.WriteAudit(r.Context(), h.Pool, id, "pipeline.create", "pipeline", pid, map[string]any{"name": req.Name, "pipeline_type": req.PipelineType})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": pid, "name": req.Name, "pipeline_type": req.PipelineType,
		"vocabulary": req.Vocabulary, "fields_schema": req.FieldsSchema,
		"is_default": req.IsDefault, "stages": createdStages,
	})
}

func (h *Handler) UpdatePipeline(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	pid := chi.URLParam(r, "id")
	var req struct {
		Name         *string        `json:"name"`
		PipelineType *string        `json:"pipeline_type"`
		Vocabulary   map[string]any `json:"vocabulary"`
		FieldsSchema []any          `json:"fields_schema"`
		IsDefault    *bool          `json:"is_default"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.PipelineType != nil && *req.PipelineType != "sales" && *req.PipelineType != "support" && *req.PipelineType != "custom" {
		httpx.Error(w, http.StatusBadRequest, "invalid pipeline_type")
		return
	}

	tx, err := h.Pool.Begin(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer tx.Rollback(r.Context())

	var exists string
	if err := tx.QueryRow(r.Context(), `SELECT id FROM crm_pipelines WHERE id = $1 AND organization_id = $2`, pid, id.OrganizationID).Scan(&exists); err != nil {
		httpx.Error(w, http.StatusNotFound, "pipeline not found")
		return
	}

	if req.IsDefault != nil && *req.IsDefault {
		if _, err := tx.Exec(r.Context(), `UPDATE crm_pipelines SET is_default = false, updated_at = now() WHERE organization_id = $1 AND id <> $2`, id.OrganizationID, pid); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "failed to clear default pipeline")
			return
		}
	}

	var vocabParam, fieldsParam *string
	if req.Vocabulary != nil {
		b, _ := json.Marshal(req.Vocabulary)
		s := string(b)
		vocabParam = &s
	}
	if req.FieldsSchema != nil {
		b, _ := json.Marshal(req.FieldsSchema)
		s := string(b)
		fieldsParam = &s
	}

	_, err = tx.Exec(r.Context(), `
		UPDATE crm_pipelines SET
			name = COALESCE($3, name),
			pipeline_type = COALESCE($4, pipeline_type),
			vocabulary = COALESCE($5::jsonb, vocabulary),
			fields_schema = COALESCE($6::jsonb, fields_schema),
			is_default = COALESCE($7, is_default),
			updated_at = now()
		WHERE id = $1 AND organization_id = $2
	`, pid, id.OrganizationID, req.Name, req.PipelineType, vocabParam, fieldsParam, req.IsDefault)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "update failed")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "commit failed")
		return
	}

	_ = auth.WriteAudit(r.Context(), h.Pool, id, "pipeline.update", "pipeline", pid, map[string]any{"updated": true})
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

func (h *Handler) CreateStage(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	paramPipeID := chi.URLParam(r, "id")
	var req struct {
		PipelineID    string   `json:"pipeline_id"`
		Name          string   `json:"name"`
		Position      *float64 `json:"position"`
		Color         string   `json:"color"`
		IsWon         bool     `json:"is_won"`
		IsLost        bool     `json:"is_lost"`
		RequiresHuman bool     `json:"requires_human"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	if paramPipeID != "" {
		req.PipelineID = paramPipeID
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.PipelineID == "" || req.Name == "" {
		httpx.Error(w, http.StatusBadRequest, "pipeline_id and name are required")
		return
	}

	var pipeExists string
	if err := h.Pool.QueryRow(r.Context(), `SELECT id FROM crm_pipelines WHERE id = $1 AND organization_id = $2`, req.PipelineID, id.OrganizationID).Scan(&pipeExists); err != nil {
		httpx.Error(w, http.StatusNotFound, "pipeline not found")
		return
	}

	pos := 1000.0
	if req.Position != nil {
		pos = *req.Position
	} else {
		_ = h.Pool.QueryRow(r.Context(), `SELECT COALESCE(MAX(position), 0) + 1000 FROM crm_stages WHERE pipeline_id = $1 AND organization_id = $2`, req.PipelineID, id.OrganizationID).Scan(&pos)
	}
	col := strings.TrimSpace(req.Color)
	if col == "" {
		col = "#64748b"
	}

	var sid string
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO crm_stages (organization_id, pipeline_id, name, position, color, is_won, is_lost, requires_human)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
	`, id.OrganizationID, req.PipelineID, req.Name, pos, col, req.IsWon, req.IsLost, req.RequiresHuman).Scan(&sid)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to create stage")
		return
	}

	_ = auth.WriteAudit(r.Context(), h.Pool, id, "stage.create", "stage", sid, map[string]any{"pipeline_id": req.PipelineID, "name": req.Name})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": sid, "pipeline_id": req.PipelineID, "name": req.Name, "position": pos,
		"color": col, "is_won": req.IsWon, "is_lost": req.IsLost, "requires_human": req.RequiresHuman,
	})
}

func (h *Handler) UpdateStage(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	sid := chi.URLParam(r, "id")
	var req struct {
		Name          *string  `json:"name"`
		Position      *float64 `json:"position"`
		Color         *string  `json:"color"`
		IsWon         *bool    `json:"is_won"`
		IsLost        *bool    `json:"is_lost"`
		RequiresHuman *bool    `json:"requires_human"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	tag, err := h.Pool.Exec(r.Context(), `
		UPDATE crm_stages SET
			name = COALESCE($3, name),
			position = COALESCE($4, position),
			color = COALESCE($5, color),
			is_won = COALESCE($6, is_won),
			is_lost = COALESCE($7, is_lost),
			requires_human = COALESCE($8, requires_human)
		WHERE id = $1 AND organization_id = $2
	`, sid, id.OrganizationID, req.Name, req.Position, req.Color, req.IsWon, req.IsLost, req.RequiresHuman)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "update failed")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(w, http.StatusNotFound, "stage not found")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "stage.update", "stage", sid, map[string]any{"updated": true})
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

func (h *Handler) DeleteStage(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	sid := chi.URLParam(r, "id")
	var exists string
	if err := h.Pool.QueryRow(r.Context(), `SELECT id FROM crm_stages WHERE id = $1 AND organization_id = $2`, sid, id.OrganizationID).Scan(&exists); err != nil {
		httpx.Error(w, http.StatusNotFound, "stage not found")
		return
	}
	var cnt int
	_ = h.Pool.QueryRow(r.Context(), `SELECT COUNT(*) FROM crm_leads WHERE stage_id = $1 AND organization_id = $2`, sid, id.OrganizationID).Scan(&cnt)
	if cnt > 0 {
		httpx.Error(w, http.StatusUnprocessableEntity, "cannot delete stage with existing leads")
		return
	}
	_, err := h.Pool.Exec(r.Context(), `DELETE FROM crm_stages WHERE id = $1 AND organization_id = $2`, sid, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "delete failed")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "stage.delete", "stage", sid, map[string]any{})
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
