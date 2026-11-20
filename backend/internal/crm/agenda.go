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
	"github.com/jackc/pgx/v5"
)

type Appointment struct {
	ID              string    `json:"id"`
	OrganizationID  string    `json:"organization_id"`
	ContactID       string    `json:"contact_id,omitempty"`
	ContactName     string    `json:"contact_name,omitempty"`
	LeadID          string    `json:"lead_id,omitempty"`
	AssignedTo      string    `json:"assigned_to,omitempty"`
	Title           string    `json:"title"`
	Description     string    `json:"description"`
	Location        string    `json:"location"`
	StartsAt        time.Time `json:"starts_at"`
	EndsAt          time.Time `json:"ends_at"`
	DurationMinutes int       `json:"duration_minutes"`
	Status          string    `json:"status"`
	Notes           string    `json:"notes"`
	CreatedBy       string    `json:"created_by,omitempty"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

type WaitlistEntry struct {
	ID              string    `json:"id"`
	OrganizationID  string    `json:"organization_id"`
	ContactID       string    `json:"contact_id,omitempty"`
	ContactName     string    `json:"contact_name"`
	ContactPhone    string    `json:"contact_phone"`
	PhoneE164       string    `json:"phone_e164"`
	ServiceName     string    `json:"service_name"`
	PreferredDate   string    `json:"preferred_date,omitempty"`
	PreferredPeriod string    `json:"preferred_period"`
	Priority        int       `json:"priority"`
	Status          string    `json:"status"`
	AppointmentID   string    `json:"appointment_id,omitempty"`
	Notes           string    `json:"notes"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

func ValidAppointmentStatus(s string) bool {
	switch s {
	case "scheduled", "confirmed", "completed", "cancelled", "no_show":
		return true
	default:
		return false
	}
}

func ValidWaitlistStatus(s string) bool {
	switch s {
	case "waiting", "notified", "scheduled", "cancelled":
		return true
	default:
		return false
	}
}

func ValidWaitlistPeriod(s string) bool {
	switch s {
	case "any", "morning", "afternoon", "evening":
		return true
	default:
		return false
	}
}

// ComputeAppointmentWindow parses RFC3339 starts_at and computes ends_at using duration_minutes (default 30)
// or explicit RFC3339 ends_at.
func ComputeAppointmentWindow(startsAtStr string, durationMinutes int, endsAtStr string) (time.Time, time.Time, int, error) {
	startsAt, err := time.Parse(time.RFC3339, strings.TrimSpace(startsAtStr))
	if err != nil {
		return time.Time{}, time.Time{}, 0, errors.New("invalid_starts_at")
	}
	if strings.TrimSpace(endsAtStr) != "" {
		endsAt, err := time.Parse(time.RFC3339, strings.TrimSpace(endsAtStr))
		if err != nil || !endsAt.After(startsAt) {
			return time.Time{}, time.Time{}, 0, errors.New("invalid_ends_at")
		}
		dur := int(endsAt.Sub(startsAt).Minutes())
		if dur <= 0 {
			dur = 30
		}
		return startsAt, endsAt, dur, nil
	}
	if durationMinutes <= 0 {
		durationMinutes = 30
	}
	endsAt := startsAt.Add(time.Duration(durationMinutes) * time.Minute)
	return startsAt, endsAt, durationMinutes, nil
}

func (h *Handler) publishAppointmentEvent(orgID, action, id string) {
	if h.Hub != nil {
		h.Hub.Publish(orgID, "appointment.updated", map[string]any{
			"action": action,
			"id":     id,
		})
	}
}

const appointmentSelectCols = `
	a.id, a.organization_id, COALESCE(a.contact_id::text, ''), COALESCE(c.name, ''),
	COALESCE(a.lead_id::text, ''), COALESCE(a.assigned_to::text, ''),
	a.title, a.description, a.location, a.starts_at, a.ends_at, a.duration_minutes,
	a.status, a.notes, COALESCE(a.created_by::text, ''), a.created_at, a.updated_at
`

func scanAppointment(row pgx.Row) (Appointment, error) {
	var a Appointment
	err := row.Scan(
		&a.ID, &a.OrganizationID, &a.ContactID, &a.ContactName,
		&a.LeadID, &a.AssignedTo,
		&a.Title, &a.Description, &a.Location, &a.StartsAt, &a.EndsAt, &a.DurationMinutes,
		&a.Status, &a.Notes, &a.CreatedBy, &a.CreatedAt, &a.UpdatedAt,
	)
	return a, err
}

func (h *Handler) ListAppointments(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	from := strings.TrimSpace(r.URL.Query().Get("from"))
	to := strings.TrimSpace(r.URL.Query().Get("to"))

	rows, err := h.Pool.Query(r.Context(), `
		SELECT `+appointmentSelectCols+`
		FROM appointments a
		LEFT JOIN contacts c ON c.id = a.contact_id
		WHERE a.organization_id = $1
		  AND ($2 = '' OR a.status = $2)
		  AND ($3 = '' OR a.starts_at >= $3::timestamptz)
		  AND ($4 = '' OR a.starts_at <= $4::timestamptz)
		ORDER BY a.starts_at ASC
		LIMIT 300
	`, id.OrganizationID, status, from, to)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db_error")
		return
	}
	defer rows.Close()

	items := make([]Appointment, 0)
	for rows.Next() {
		a, err := scanAppointment(rows)
		if err == nil {
			items = append(items, a)
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items, "appointments": items})
}

func (h *Handler) GetAppointment(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	apptID := chi.URLParam(r, "id")
	a, err := scanAppointment(h.Pool.QueryRow(r.Context(), `
		SELECT `+appointmentSelectCols+`
		FROM appointments a
		LEFT JOIN contacts c ON c.id = a.contact_id
		WHERE a.id = $1 AND a.organization_id = $2
	`, apptID, id.OrganizationID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "appointment_not_found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "db_error")
		return
	}
	httpx.JSON(w, http.StatusOK, a)
}

func (h *Handler) CreateAppointment(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		Title           string `json:"title"`
		Description     string `json:"description"`
		Location        string `json:"location"`
		StartsAt        string `json:"starts_at"`
		EndsAt          string `json:"ends_at"`
		DurationMinutes int    `json:"duration_minutes"`
		Status          string `json:"status"`
		Notes           string `json:"notes"`
		ContactID       string `json:"contact_id"`
		LeadID          string `json:"lead_id"`
		AssignedTo      string `json:"assigned_to"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_json")
		return
	}

	title := strings.TrimSpace(req.Title)
	if title == "" {
		httpx.Error(w, http.StatusBadRequest, "title_required")
		return
	}

	startsAt, endsAt, dur, err := ComputeAppointmentWindow(req.StartsAt, req.DurationMinutes, req.EndsAt)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}

	status := strings.TrimSpace(req.Status)
	if status == "" {
		status = "scheduled"
	}
	if !ValidAppointmentStatus(status) {
		httpx.Error(w, http.StatusBadRequest, "invalid_status")
		return
	}

	if status != "cancelled" && status != "no_show" {
		var overlap bool
		if err := h.Pool.QueryRow(r.Context(), `
			SELECT EXISTS(
				SELECT 1 FROM appointments
				WHERE organization_id = $1
				  AND status NOT IN ('cancelled', 'no_show')
				  AND starts_at < $3
				  AND ends_at > $2
			)
		`, id.OrganizationID, startsAt, endsAt).Scan(&overlap); err == nil && overlap {
			httpx.Error(w, http.StatusConflict, "appointment_overlap")
			return
		}
	}

	var newID string
	err = h.Pool.QueryRow(r.Context(), `
		INSERT INTO appointments (
			organization_id, contact_id, lead_id, assigned_to,
			title, description, location, starts_at, ends_at, duration_minutes,
			status, notes, created_by
		) VALUES (
			$1, NULLIF($2,'')::uuid, NULLIF($3,'')::uuid, NULLIF($4,'')::uuid,
			$5, $6, $7, $8, $9, $10,
			$11, $12, NULLIF($13,'')::uuid
		)
		RETURNING id
	`, id.OrganizationID, strings.TrimSpace(req.ContactID), strings.TrimSpace(req.LeadID), strings.TrimSpace(req.AssignedTo),
		title, strings.TrimSpace(req.Description), strings.TrimSpace(req.Location), startsAt, endsAt, dur,
		status, strings.TrimSpace(req.Notes), id.UserID,
	).Scan(&newID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db_error")
		return
	}

	a, err := scanAppointment(h.Pool.QueryRow(r.Context(), `
		SELECT `+appointmentSelectCols+`
		FROM appointments a
		LEFT JOIN contacts c ON c.id = a.contact_id
		WHERE a.id = $1 AND a.organization_id = $2
	`, newID, id.OrganizationID))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db_error")
		return
	}

	h.publishAppointmentEvent(id.OrganizationID, "created", a.ID)
	httpx.JSON(w, http.StatusCreated, a)
}

func (h *Handler) UpdateAppointment(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	apptID := chi.URLParam(r, "id")

	var req struct {
		Title           *string `json:"title"`
		Description     *string `json:"description"`
		Location        *string `json:"location"`
		StartsAt        *string `json:"starts_at"`
		EndsAt          *string `json:"ends_at"`
		DurationMinutes *int    `json:"duration_minutes"`
		Status          *string `json:"status"`
		Notes           *string `json:"notes"`
		ContactID       *string `json:"contact_id"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_json")
		return
	}

	cur, err := scanAppointment(h.Pool.QueryRow(r.Context(), `
		SELECT `+appointmentSelectCols+`
		FROM appointments a
		LEFT JOIN contacts c ON c.id = a.contact_id
		WHERE a.id = $1 AND a.organization_id = $2
	`, apptID, id.OrganizationID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "appointment_not_found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "db_error")
		return
	}

	if req.Title != nil {
		if strings.TrimSpace(*req.Title) == "" {
			httpx.Error(w, http.StatusBadRequest, "title_required")
			return
		}
		cur.Title = strings.TrimSpace(*req.Title)
	}
	if req.Description != nil {
		cur.Description = strings.TrimSpace(*req.Description)
	}
	if req.Location != nil {
		cur.Location = strings.TrimSpace(*req.Location)
	}
	if req.Notes != nil {
		cur.Notes = strings.TrimSpace(*req.Notes)
	}
	if req.Status != nil {
		st := strings.TrimSpace(*req.Status)
		if !ValidAppointmentStatus(st) {
			httpx.Error(w, http.StatusBadRequest, "invalid_status")
			return
		}
		cur.Status = st
	}

	timeChanged := false
	if req.StartsAt != nil || req.EndsAt != nil || req.DurationMinutes != nil {
		timeChanged = true
		startsStr := cur.StartsAt.Format(time.RFC3339)
		if req.StartsAt != nil {
			startsStr = *req.StartsAt
		}
		dur := cur.DurationMinutes
		if req.DurationMinutes != nil {
			dur = *req.DurationMinutes
		}
		endsStr := ""
		if req.EndsAt != nil {
			endsStr = *req.EndsAt
		}
		s, e, d, err := ComputeAppointmentWindow(startsStr, dur, endsStr)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		cur.StartsAt = s
		cur.EndsAt = e
		cur.DurationMinutes = d
	}

	if timeChanged && cur.Status != "cancelled" && cur.Status != "no_show" {
		var overlap bool
		if err := h.Pool.QueryRow(r.Context(), `
			SELECT EXISTS(
				SELECT 1 FROM appointments
				WHERE organization_id = $1
				  AND id <> $2
				  AND status NOT IN ('cancelled', 'no_show')
				  AND starts_at < $4
				  AND ends_at > $3
			)
		`, id.OrganizationID, apptID, cur.StartsAt, cur.EndsAt).Scan(&overlap); err == nil && overlap {
			httpx.Error(w, http.StatusConflict, "appointment_overlap")
			return
		}
	}

	contactID := cur.ContactID
	if req.ContactID != nil {
		contactID = strings.TrimSpace(*req.ContactID)
	}

	_, err = h.Pool.Exec(r.Context(), `
		UPDATE appointments
		SET title = $3,
		    description = $4,
		    location = $5,
		    starts_at = $6,
		    ends_at = $7,
		    duration_minutes = $8,
		    status = $9,
		    notes = $10,
		    contact_id = NULLIF($11,'')::uuid,
		    updated_at = now()
		WHERE id = $1 AND organization_id = $2
	`, apptID, id.OrganizationID, cur.Title, cur.Description, cur.Location, cur.StartsAt, cur.EndsAt, cur.DurationMinutes, cur.Status, cur.Notes, contactID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db_error")
		return
	}

	updated, _ := scanAppointment(h.Pool.QueryRow(r.Context(), `
		SELECT `+appointmentSelectCols+`
		FROM appointments a
		LEFT JOIN contacts c ON c.id = a.contact_id
		WHERE a.id = $1 AND a.organization_id = $2
	`, apptID, id.OrganizationID))

	h.publishAppointmentEvent(id.OrganizationID, "updated", apptID)
	httpx.JSON(w, http.StatusOK, updated)
}

func (h *Handler) DeleteAppointment(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	apptID := chi.URLParam(r, "id")
	tag, err := h.Pool.Exec(r.Context(), `DELETE FROM appointments WHERE id = $1 AND organization_id = $2`, apptID, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db_error")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(w, http.StatusNotFound, "appointment_not_found")
		return
	}
	h.publishAppointmentEvent(id.OrganizationID, "deleted", apptID)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

const waitlistSelectCols = `
	id, organization_id, COALESCE(contact_id::text, ''), contact_name, contact_phone,
	service_name, COALESCE(preferred_date::text, ''), preferred_period, priority,
	status, COALESCE(appointment_id::text, ''), notes, created_at, updated_at
`

func scanWaitlistEntry(row pgx.Row) (WaitlistEntry, error) {
	var w WaitlistEntry
	err := row.Scan(
		&w.ID, &w.OrganizationID, &w.ContactID, &w.ContactName, &w.ContactPhone,
		&w.ServiceName, &w.PreferredDate, &w.PreferredPeriod, &w.Priority,
		&w.Status, &w.AppointmentID, &w.Notes, &w.CreatedAt, &w.UpdatedAt,
	)
	w.PhoneE164 = w.ContactPhone
	return w, err
}

func (h *Handler) ListWaitlist(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	rows, err := h.Pool.Query(r.Context(), `
		SELECT `+waitlistSelectCols+`
		FROM waitlist_entries
		WHERE organization_id = $1
		  AND ($2 = '' OR status = $2)
		ORDER BY priority DESC, created_at ASC
		LIMIT 200
	`, id.OrganizationID, status)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db_error")
		return
	}
	defer rows.Close()

	items := make([]WaitlistEntry, 0)
	for rows.Next() {
		item, err := scanWaitlistEntry(rows)
		if err == nil {
			items = append(items, item)
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items, "waitlist": items})
}

func (h *Handler) CreateWaitlistEntry(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		ContactID       string `json:"contact_id"`
		ContactName     string `json:"contact_name"`
		PhoneE164       string `json:"phone_e164"`
		ContactPhone    string `json:"contact_phone"`
		ServiceName     string `json:"service_name"`
		PreferredDate   string `json:"preferred_date"`
		PreferredPeriod string `json:"preferred_period"`
		Priority        int    `json:"priority"`
		Notes           string `json:"notes"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_json")
		return
	}

	name := strings.TrimSpace(req.ContactName)
	if name == "" {
		httpx.Error(w, http.StatusBadRequest, "contact_name_required")
		return
	}
	phone := strings.TrimSpace(req.PhoneE164)
	if phone == "" {
		phone = strings.TrimSpace(req.ContactPhone)
	}
	period := strings.TrimSpace(req.PreferredPeriod)
	if period == "" {
		period = "any"
	}
	if !ValidWaitlistPeriod(period) {
		httpx.Error(w, http.StatusBadRequest, "invalid_preferred_period")
		return
	}

	entry, err := scanWaitlistEntry(h.Pool.QueryRow(r.Context(), `
		INSERT INTO waitlist_entries (
			organization_id, contact_id, contact_name, contact_phone,
			service_name, preferred_date, preferred_period, priority, notes
		) VALUES (
			$1, NULLIF($2,'')::uuid, $3, $4,
			$5, NULLIF($6,'')::date, $7, $8, $9
		)
		RETURNING `+waitlistSelectCols,
		id.OrganizationID, strings.TrimSpace(req.ContactID), name, phone,
		strings.TrimSpace(req.ServiceName), strings.TrimSpace(req.PreferredDate), period, req.Priority, strings.TrimSpace(req.Notes),
	))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db_error")
		return
	}

	h.publishAppointmentEvent(id.OrganizationID, "waitlist_created", entry.ID)
	httpx.JSON(w, http.StatusCreated, entry)
}

func (h *Handler) UpdateWaitlistEntry(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	entryID := chi.URLParam(r, "id")
	var req struct {
		Status          *string `json:"status"`
		PreferredPeriod *string `json:"preferred_period"`
		Priority        *int    `json:"priority"`
		Notes           *string `json:"notes"`
		ServiceName     *string `json:"service_name"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_json")
		return
	}

	if req.Status != nil && !ValidWaitlistStatus(strings.TrimSpace(*req.Status)) {
		httpx.Error(w, http.StatusBadRequest, "invalid_status")
		return
	}
	if req.PreferredPeriod != nil && !ValidWaitlistPeriod(strings.TrimSpace(*req.PreferredPeriod)) {
		httpx.Error(w, http.StatusBadRequest, "invalid_preferred_period")
		return
	}

	entry, err := scanWaitlistEntry(h.Pool.QueryRow(r.Context(), `
		UPDATE waitlist_entries
		SET status = COALESCE(NULLIF($3, ''), status),
		    preferred_period = COALESCE(NULLIF($4, ''), preferred_period),
		    priority = COALESCE($5, priority),
		    notes = COALESCE($6, notes),
		    service_name = COALESCE($7, service_name),
		    updated_at = now()
		WHERE id = $1 AND organization_id = $2
		RETURNING `+waitlistSelectCols,
		entryID, id.OrganizationID,
		trimPtr(req.Status), trimPtr(req.PreferredPeriod), req.Priority, req.Notes, req.ServiceName,
	))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "waitlist_entry_not_found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "db_error")
		return
	}
	h.publishAppointmentEvent(id.OrganizationID, "waitlist_updated", entry.ID)
	httpx.JSON(w, http.StatusOK, entry)
}

func (h *Handler) DeleteWaitlistEntry(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	entryID := chi.URLParam(r, "id")
	tag, err := h.Pool.Exec(r.Context(), `DELETE FROM waitlist_entries WHERE id = $1 AND organization_id = $2`, entryID, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db_error")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(w, http.StatusNotFound, "waitlist_entry_not_found")
		return
	}
	h.publishAppointmentEvent(id.OrganizationID, "waitlist_deleted", entryID)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (h *Handler) PromoteWaitlistEntry(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	entryID := chi.URLParam(r, "id")

	var req struct {
		Title           string `json:"title"`
		StartsAt        string `json:"starts_at"`
		DurationMinutes int    `json:"duration_minutes"`
		Notes           string `json:"notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err.Error() != "EOF" {
		httpx.Error(w, http.StatusBadRequest, "invalid_json")
		return
	}

	tx, err := h.Pool.Begin(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db_error")
		return
	}
	defer tx.Rollback(r.Context())

	entry, err := scanWaitlistEntry(tx.QueryRow(r.Context(), `
		SELECT `+waitlistSelectCols+`
		FROM waitlist_entries
		WHERE id = $1 AND organization_id = $2
		FOR UPDATE
	`, entryID, id.OrganizationID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "waitlist_entry_not_found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "db_error")
		return
	}

	startsAtStr := strings.TrimSpace(req.StartsAt)
	if startsAtStr == "" {
		startsAtStr = time.Now().UTC().Add(1 * time.Hour).Truncate(time.Hour).Format(time.RFC3339)
	}
	startsAt, endsAt, dur, err := ComputeAppointmentWindow(startsAtStr, req.DurationMinutes, "")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}

	var overlap bool
	if err := tx.QueryRow(r.Context(), `
		SELECT EXISTS(
			SELECT 1 FROM appointments
			WHERE organization_id = $1
			  AND status NOT IN ('cancelled', 'no_show')
			  AND starts_at < $3
			  AND ends_at > $2
		)
	`, id.OrganizationID, startsAt, endsAt).Scan(&overlap); err == nil && overlap {
		httpx.Error(w, http.StatusConflict, "appointment_overlap")
		return
	}

	title := strings.TrimSpace(req.Title)
	if title == "" {
		if entry.ServiceName != "" {
			title = entry.ServiceName + " — " + entry.ContactName
		} else {
			title = "Cita: " + entry.ContactName
		}
	}
	notes := strings.TrimSpace(req.Notes)
	if notes == "" {
		notes = entry.Notes
	}

	var apptID string
	err = tx.QueryRow(r.Context(), `
		INSERT INTO appointments (
			organization_id, contact_id, title, starts_at, ends_at, duration_minutes,
			status, notes, created_by
		) VALUES (
			$1, NULLIF($2,'')::uuid, $3, $4, $5, $6,
			'scheduled', $7, NULLIF($8,'')::uuid
		)
		RETURNING id
	`, id.OrganizationID, entry.ContactID, title, startsAt, endsAt, dur, notes, id.UserID).Scan(&apptID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db_error")
		return
	}

	updatedEntry, err := scanWaitlistEntry(tx.QueryRow(r.Context(), `
		UPDATE waitlist_entries
		SET status = 'scheduled', appointment_id = $3, updated_at = now()
		WHERE id = $1 AND organization_id = $2
		RETURNING `+waitlistSelectCols,
		entryID, id.OrganizationID, apptID,
	))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db_error")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db_error")
		return
	}

	appt, _ := scanAppointment(h.Pool.QueryRow(r.Context(), `
		SELECT `+appointmentSelectCols+`
		FROM appointments a
		LEFT JOIN contacts c ON c.id = a.contact_id
		WHERE a.id = $1 AND a.organization_id = $2
	`, apptID, id.OrganizationID))

	h.publishAppointmentEvent(id.OrganizationID, "promoted", apptID)
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"appointment":    appt,
		"waitlist_entry": updatedEntry,
	})
}

func trimPtr(p *string) string {
	if p == nil {
		return ""
	}
	return strings.TrimSpace(*p)
}
