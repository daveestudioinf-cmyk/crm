package crm

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/httpx"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func parseNullableTime(raw string) (*time.Time, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil, nil
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return &t, nil
	}
	if t, err := time.Parse("2006-01-02T15:04", s); err == nil {
		return &t, nil
	}
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func validTaskStatus(s string) bool {
	switch s {
	case "pending", "in_progress", "done", "cancelled":
		return true
	default:
		return false
	}
}

func (h *Handler) ListTasks(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	statusFilter := strings.TrimSpace(r.URL.Query().Get("status"))
	leadID := strings.TrimSpace(r.URL.Query().Get("lead_id"))
	contactID := strings.TrimSpace(r.URL.Query().Get("contact_id"))

	rows, err := h.Pool.Query(r.Context(), `
		SELECT id, title, COALESCE(description,''), status, due_at, COALESCE(recurrence,''),
		       lead_id::text, contact_id::text, assigned_to::text, created_at, updated_at
		FROM crm_tasks
		WHERE organization_id = $1
		  AND ($2 = '' OR ($2 = 'overdue' AND status IN ('pending','in_progress') AND due_at IS NOT NULL AND due_at < now()) OR ($2 <> 'overdue' AND status = $2))
		  AND ($3 = '' OR lead_id::text = $3)
		  AND ($4 = '' OR contact_id::text = $4)
		ORDER BY CASE WHEN status IN ('pending','in_progress') THEN 0 ELSE 1 END, due_at ASC NULLS LAST, created_at DESC
		LIMIT 200
	`, id.OrganizationID, statusFilter, leadID, contactID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var tid, title, desc, status, recurrence string
		var leadPtr, contactPtr, assignedPtr *string
		var due, created, updated any
		_ = rows.Scan(&tid, &title, &desc, &status, &due, &recurrence, &leadPtr, &contactPtr, &assignedPtr, &created, &updated)
		out = append(out, map[string]any{
			"id": tid, "title": title, "description": desc, "status": status,
			"due_at": due, "recurrence": recurrence, "lead_id": leadPtr,
			"contact_id": contactPtr, "assigned_to": assignedPtr,
			"created_at": created, "updated_at": updated,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) CreateTask(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		Title       string  `json:"title"`
		Description string  `json:"description"`
		Status      string  `json:"status"`
		DueAt       *string `json:"due_at"`
		Recurrence  *string `json:"recurrence"`
		ContactID   *string `json:"contact_id"`
		LeadID      *string `json:"lead_id"`
		AssignedTo  *string `json:"assigned_to"`
	}
	if err := httpx.Decode(r, &req); err != nil || strings.TrimSpace(req.Title) == "" {
		httpx.Error(w, http.StatusBadRequest, "title required")
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Status == "" {
		req.Status = "pending"
	}
	if !validTaskStatus(req.Status) {
		httpx.Error(w, http.StatusBadRequest, "invalid status")
		return
	}

	var dueTime *time.Time
	if req.DueAt != nil && strings.TrimSpace(*req.DueAt) != "" {
		parsed, err := parseNullableTime(*req.DueAt)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid due_at format")
			return
		}
		dueTime = parsed
	}

	assignedTo := id.UserID
	if req.AssignedTo != nil {
		s := strings.TrimSpace(*req.AssignedTo)
		if s != "" {
			if _, err := uuid.Parse(s); err != nil {
				httpx.Error(w, http.StatusBadRequest, "invalid assigned_to")
				return
			}
			assignedTo = s
		}
	}

	var leadID *string
	if req.LeadID != nil {
		s := strings.TrimSpace(*req.LeadID)
		if s != "" {
			if _, err := uuid.Parse(s); err != nil {
				httpx.Error(w, http.StatusBadRequest, "invalid lead_id")
				return
			}
			var exists bool
			if err := h.Pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM crm_leads WHERE id = $1 AND organization_id = $2)`, s, id.OrganizationID).Scan(&exists); err != nil || !exists {
				httpx.Error(w, http.StatusNotFound, "lead not found")
				return
			}
			leadID = &s
		}
	}

	var contactID *string
	if req.ContactID != nil {
		s := strings.TrimSpace(*req.ContactID)
		if s != "" {
			if _, err := uuid.Parse(s); err != nil {
				httpx.Error(w, http.StatusBadRequest, "invalid contact_id")
				return
			}
			var exists bool
			if err := h.Pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM contacts WHERE id = $1 AND organization_id = $2)`, s, id.OrganizationID).Scan(&exists); err != nil || !exists {
				httpx.Error(w, http.StatusNotFound, "contact not found")
				return
			}
			contactID = &s
		}
	}

	var recurrence string
	if req.Recurrence != nil {
		recurrence = strings.TrimSpace(*req.Recurrence)
	}

	var tid string
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO crm_tasks (organization_id, title, description, status, due_at, recurrence, contact_id, lead_id, assigned_to)
		VALUES ($1, $2, $3, $4, $5, NULLIF($6,''), NULLIF($7,'')::uuid, NULLIF($8,'')::uuid, NULLIF($9,'')::uuid) RETURNING id
	`, id.OrganizationID, req.Title, req.Description, req.Status, dueTime, recurrence, contactID, leadID, assignedTo).Scan(&tid)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "task.create", "task", tid, map[string]any{"title": req.Title})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": tid, "title": req.Title, "description": req.Description,
		"status": req.Status, "due_at": dueTime, "recurrence": recurrence,
		"lead_id": leadID, "contact_id": contactID, "assigned_to": assignedTo,
	})
}

func (h *Handler) UpdateTask(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	tid := chi.URLParam(r, "id")
	var req struct {
		Title       *string `json:"title"`
		Description *string `json:"description"`
		Status      *string `json:"status"`
		DueAt       *string `json:"due_at"`
		Recurrence  *string `json:"recurrence"`
		AssignedTo  *string `json:"assigned_to"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.Status != nil && !validTaskStatus(*req.Status) {
		httpx.Error(w, http.StatusBadRequest, "invalid status")
		return
	}

	clearDue := false
	var dueTime *time.Time
	if req.DueAt != nil {
		if strings.TrimSpace(*req.DueAt) == "" {
			clearDue = true
		} else {
			parsed, err := parseNullableTime(*req.DueAt)
			if err != nil {
				httpx.Error(w, http.StatusBadRequest, "invalid due_at format")
				return
			}
			dueTime = parsed
		}
	}

	var assignedTo *string
	if req.AssignedTo != nil {
		s := strings.TrimSpace(*req.AssignedTo)
		if s != "" {
			if _, err := uuid.Parse(s); err != nil {
				httpx.Error(w, http.StatusBadRequest, "invalid assigned_to")
				return
			}
			assignedTo = &s
		}
	}

	var retID, retTitle, retDesc, retStatus, retRecurrence string
	err := h.Pool.QueryRow(r.Context(), `
		UPDATE crm_tasks SET
			title = COALESCE($3, title),
			description = COALESCE($4, description),
			status = COALESCE($5, status),
			due_at = CASE WHEN $6 THEN NULL WHEN $7::timestamptz IS NOT NULL THEN $7::timestamptz ELSE due_at END,
			recurrence = CASE WHEN $8::text IS NULL THEN recurrence ELSE NULLIF($8::text, '') END,
			assigned_to = COALESCE(NULLIF($9, '')::uuid, assigned_to),
			updated_at = now()
		WHERE id = $1 AND organization_id = $2
		RETURNING id, title, COALESCE(description,''), status, COALESCE(recurrence,'')
	`, tid, id.OrganizationID, req.Title, req.Description, req.Status, clearDue, dueTime, req.Recurrence, assignedTo).Scan(&retID, &retTitle, &retDesc, &retStatus, &retRecurrence)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "task not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "update failed")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "task.update", "task", tid, map[string]any{"updated": true})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": retID, "title": retTitle, "description": retDesc, "status": retStatus, "recurrence": retRecurrence,
	})
}

func (h *Handler) DeleteTask(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	tid := chi.URLParam(r, "id")
	tag, err := h.Pool.Exec(r.Context(), `DELETE FROM crm_tasks WHERE id = $1 AND organization_id = $2`, tid, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "delete failed")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(w, http.StatusNotFound, "task not found")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "task.delete", "task", tid, map[string]any{})
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

type taskPlanItem struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	OffsetDays  int    `json:"offset_days"`
	Recurrence  string `json:"recurrence"`
}

func (h *Handler) ListTaskPlans(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(), `
		SELECT id, name, COALESCE(description,''), items, created_at, updated_at
		FROM crm_task_plans WHERE organization_id = $1 ORDER BY created_at DESC
	`, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var pid, name, desc string
		var items []any
		var createdAt, updatedAt any
		_ = rows.Scan(&pid, &name, &desc, &items, &createdAt, &updatedAt)
		if items == nil {
			items = []any{}
		}
		out = append(out, map[string]any{
			"id": pid, "name": name, "description": desc, "items": items,
			"created_at": createdAt, "updated_at": updatedAt,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) CreateTaskPlan(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		Name        string         `json:"name"`
		Description string         `json:"description"`
		Items       []taskPlanItem `json:"items"`
	}
	if err := httpx.Decode(r, &req); err != nil || strings.TrimSpace(req.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "name required")
		return
	}
	if req.Items == nil {
		req.Items = []taskPlanItem{}
	}
	itemsJSON, _ := json.Marshal(req.Items)
	var pid string
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO crm_task_plans (organization_id, name, description, items, created_by)
		VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id
	`, id.OrganizationID, strings.TrimSpace(req.Name), req.Description, string(itemsJSON), id.UserID).Scan(&pid)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to create task plan")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "task_plan.create", "task_plan", pid, map[string]any{"name": req.Name})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": pid, "name": strings.TrimSpace(req.Name), "description": req.Description, "items": req.Items,
	})
}

func (h *Handler) DeleteTaskPlan(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	pid := chi.URLParam(r, "id")
	tag, err := h.Pool.Exec(r.Context(), `DELETE FROM crm_task_plans WHERE id = $1 AND organization_id = $2`, pid, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "delete failed")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(w, http.StatusNotFound, "task plan not found")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "task_plan.delete", "task_plan", pid, map[string]any{})
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (h *Handler) ApplyTaskPlan(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	pid := chi.URLParam(r, "id")
	var req struct {
		LeadID     *string `json:"lead_id"`
		ContactID  *string `json:"contact_id"`
		AssignedTo *string `json:"assigned_to"`
	}
	_ = httpx.Decode(r, &req)

	var rawItems []byte
	if err := h.Pool.QueryRow(r.Context(), `SELECT items FROM crm_task_plans WHERE id = $1 AND organization_id = $2`, pid, id.OrganizationID).Scan(&rawItems); err != nil {
		httpx.Error(w, http.StatusNotFound, "task plan not found")
		return
	}
	var items []taskPlanItem
	_ = json.Unmarshal(rawItems, &items)

	assignedTo := id.UserID
	if req.AssignedTo != nil {
		s := strings.TrimSpace(*req.AssignedTo)
		if s != "" {
			if _, err := uuid.Parse(s); err != nil {
				httpx.Error(w, http.StatusBadRequest, "invalid assigned_to")
				return
			}
			assignedTo = s
		}
	}

	var leadID *string
	if req.LeadID != nil {
		s := strings.TrimSpace(*req.LeadID)
		if s != "" {
			if _, err := uuid.Parse(s); err != nil {
				httpx.Error(w, http.StatusBadRequest, "invalid lead_id")
				return
			}
			var exists bool
			if err := h.Pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM crm_leads WHERE id = $1 AND organization_id = $2)`, s, id.OrganizationID).Scan(&exists); err != nil || !exists {
				httpx.Error(w, http.StatusNotFound, "lead not found")
				return
			}
			leadID = &s
		}
	}

	var contactID *string
	if req.ContactID != nil {
		s := strings.TrimSpace(*req.ContactID)
		if s != "" {
			if _, err := uuid.Parse(s); err != nil {
				httpx.Error(w, http.StatusBadRequest, "invalid contact_id")
				return
			}
			var exists bool
			if err := h.Pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM contacts WHERE id = $1 AND organization_id = $2)`, s, id.OrganizationID).Scan(&exists); err != nil || !exists {
				httpx.Error(w, http.StatusNotFound, "contact not found")
				return
			}
			contactID = &s
		}
	}

	tx, err := h.Pool.Begin(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	now := time.Now().UTC()
	created := []map[string]any{}
	for _, it := range items {
		if strings.TrimSpace(it.Title) == "" {
			continue
		}
		due := now.Add(time.Duration(it.OffsetDays) * 24 * time.Hour)
		var tid string
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO crm_tasks (organization_id, title, description, status, due_at, recurrence, lead_id, contact_id, assigned_to)
			VALUES ($1, $2, $3, 'pending', $4, NULLIF($5,''), NULLIF($6,'')::uuid, NULLIF($7,'')::uuid, NULLIF($8,'')::uuid) RETURNING id
		`, id.OrganizationID, strings.TrimSpace(it.Title), it.Description, due, strings.TrimSpace(it.Recurrence), leadID, contactID, assignedTo).Scan(&tid); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "failed to apply task plan")
			return
		}
		created = append(created, map[string]any{"id": tid, "title": it.Title, "due_at": due})
	}
	if err := tx.Commit(r.Context()); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to commit task plan")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "task_plan.apply", "task_plan", pid, map[string]any{"created": len(created)})
	httpx.JSON(w, http.StatusCreated, map[string]any{"created": len(created), "tasks": created})
}
