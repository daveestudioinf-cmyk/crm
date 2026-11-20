package crm_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/crm"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/db"
	"github.com/go-chi/chi/v5"
)

func setupM3Router(h *crm.Handler) *chi.Mux {
	r := chi.NewRouter()
	r.Get("/api/v1/pipelines", h.ListPipelines)
	r.Get("/api/v1/leads", h.ListLeads)
	r.Get("/api/v1/leads/{id}", h.GetLead)
	r.Group(func(r chi.Router) {
		r.Use(auth.RequireRole("agent"))
		r.Post("/api/v1/leads", h.CreateLead)
		r.Patch("/api/v1/leads/{id}", h.UpdateLead)
		r.Delete("/api/v1/leads/{id}", h.DeleteLead)
		r.Post("/api/v1/leads/bulk", h.BulkMoveLeads)
		r.Post("/api/v1/leads/{id}/links", h.CreateLeadLink)
		r.Delete("/api/v1/leads/{id}/links/{linkId}", h.DeleteLeadLink)
		r.Post("/api/v1/leads/{id}/activities", h.CreateLeadActivity)
		r.Post("/api/v1/leads/{id}/attachments", h.CreateLeadAttachment)
		r.Delete("/api/v1/leads/{id}/attachments/{attId}", h.DeleteLeadAttachment)
		r.Post("/api/v1/tasks", h.CreateTask)
		r.Patch("/api/v1/tasks/{id}", h.UpdateTask)
		r.Delete("/api/v1/tasks/{id}", h.DeleteTask)
		r.Post("/api/v1/task-plans", h.CreateTaskPlan)
		r.Delete("/api/v1/task-plans/{id}", h.DeleteTaskPlan)
		r.Post("/api/v1/task-plans/{id}/apply", h.ApplyTaskPlan)
	})
	r.Group(func(r chi.Router) {
		r.Use(auth.RequireRole("manager"))
		r.Post("/api/v1/pipelines", h.CreatePipeline)
		r.Patch("/api/v1/pipelines/{id}", h.UpdatePipeline)
		r.Post("/api/v1/pipelines/{id}/stages", h.CreateStage)
		r.Post("/api/v1/stages", h.CreateStage)
		r.Patch("/api/v1/stages/{id}", h.UpdateStage)
		r.Delete("/api/v1/stages/{id}", h.DeleteStage)
		r.Post("/api/v1/products", h.CreateProduct)
		r.Patch("/api/v1/products/{id}", h.UpdateProduct)
		r.Delete("/api/v1/products/{id}", h.DeleteProduct)
	})
	r.Get("/api/v1/tasks", h.ListTasks)
	r.Get("/api/v1/task-plans", h.ListTaskPlans)
	r.Get("/api/v1/products", h.ListProducts)
	return r
}

func TestM3_RBAC(t *testing.T) {
	h := &crm.Handler{}
	r := setupM3Router(h)

	viewer := auth.Identity{UserID: "u-v", OrganizationID: "org-1", Role: "viewer"}
	agent := auth.Identity{UserID: "u-a", OrganizationID: "org-1", Role: "agent"}

	// Viewer cannot mutate leads, tasks, task-plans, pipelines, stages, or products
	viewerBlocked := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/v1/leads"},
		{http.MethodPatch, "/api/v1/leads/l1"},
		{http.MethodDelete, "/api/v1/leads/l1"},
		{http.MethodPost, "/api/v1/leads/bulk"},
		{http.MethodPost, "/api/v1/leads/l1/links"},
		{http.MethodPost, "/api/v1/tasks"},
		{http.MethodDelete, "/api/v1/tasks/t1"},
		{http.MethodPost, "/api/v1/task-plans"},
		{http.MethodPost, "/api/v1/pipelines"},
		{http.MethodPost, "/api/v1/products"},
	}
	for _, tc := range viewerBlocked {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, withIdentity(httptest.NewRequest(tc.method, tc.path, strings.NewReader(`{}`)), viewer))
		if rec.Code != http.StatusForbidden {
			t.Fatalf("expected 403 for viewer on %s %s, got %d", tc.method, tc.path, rec.Code)
		}
	}

	// Agent cannot mutate pipelines, stages, or products (manager+ only)
	agentBlocked := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/v1/pipelines"},
		{http.MethodPatch, "/api/v1/pipelines/p1"},
		{http.MethodPost, "/api/v1/stages"},
		{http.MethodPatch, "/api/v1/stages/s1"},
		{http.MethodDelete, "/api/v1/stages/s1"},
		{http.MethodPost, "/api/v1/products"},
		{http.MethodPatch, "/api/v1/products/pr1"},
		{http.MethodDelete, "/api/v1/products/pr1"},
	}
	for _, tc := range agentBlocked {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, withIdentity(httptest.NewRequest(tc.method, tc.path, strings.NewReader(`{}`)), agent))
		if rec.Code != http.StatusForbidden {
			t.Fatalf("expected 403 for agent on %s %s, got %d", tc.method, tc.path, rec.Code)
		}
	}
}

func TestM3_ValidationUnit(t *testing.T) {
	h := &crm.Handler{}
	r := setupM3Router(h)
	mgr := auth.Identity{UserID: "u-m", OrganizationID: "org-1", Role: "manager"}

	// Bulk > 50 -> 422
	ids51 := make([]string, 51)
	for i := range ids51 {
		ids51[i] = fmt.Sprintf("00000000-0000-0000-0000-%012d", i+1)
	}
	b51, _ := json.Marshal(map[string]any{"lead_ids": ids51, "stage_id": "s1"})
	recBulk := httptest.NewRecorder()
	r.ServeHTTP(recBulk, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/leads/bulk", strings.NewReader(string(b51))), mgr))
	if recBulk.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for bulk > 50, got %d: %s", recBulk.Code, recBulk.Body.String())
	}

	// Self-link -> 422
	recSelf := httptest.NewRecorder()
	r.ServeHTTP(recSelf, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/leads/l1/links", strings.NewReader(`{"target_lead_id":"l1","link_type":"related"}`)), mgr))
	if recSelf.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for self link, got %d", recSelf.Code)
	}

	// Product negative price/stock -> 422
	recProd := httptest.NewRecorder()
	r.ServeHTTP(recProd, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/products", strings.NewReader(`{"name":"Plan","price_cents":-1}`)), mgr))
	if recProd.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for negative price_cents, got %d", recProd.Code)
	}
	recProd2 := httptest.NewRecorder()
	r.ServeHTTP(recProd2, withIdentity(httptest.NewRequest(http.MethodPatch, "/api/v1/products/p1", strings.NewReader(`{"stock_qty":-5}`)), mgr))
	if recProd2.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for negative stock_qty, got %d", recProd2.Code)
	}

	// Task invalid status / due_at -> 400
	recTask1 := httptest.NewRecorder()
	r.ServeHTTP(recTask1, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/tasks", strings.NewReader(`{"title":"T1","status":"invalid_st"}`)), mgr))
	if recTask1.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid task status, got %d", recTask1.Code)
	}
	recTask2 := httptest.NewRecorder()
	r.ServeHTTP(recTask2, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/tasks", strings.NewReader(`{"title":"T1","due_at":"not-a-date"}`)), mgr))
	if recTask2.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid due_at, got %d", recTask2.Code)
	}

	// Malformed UUIDs -> 400
	uuidCases := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodPost, "/api/v1/tasks", `{"title":"T1","lead_id":"not-a-uuid"}`},
		{http.MethodPost, "/api/v1/tasks", `{"title":"T1","contact_id":"bad-uuid"}`},
		{http.MethodPost, "/api/v1/tasks", `{"title":"T1","assigned_to":"bad-uuid"}`},
		{http.MethodPatch, "/api/v1/tasks/00000000-0000-0000-0000-000000000001", `{"assigned_to":"bad-uuid"}`},
		{http.MethodPatch, "/api/v1/leads/00000000-0000-0000-0000-000000000001", `{"owner_user_id":"bad-uuid"}`},
		{http.MethodPatch, "/api/v1/leads/00000000-0000-0000-0000-000000000001", `{"stage_id":"bad-uuid"}`},
	}
	for _, tc := range uuidCases {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, withIdentity(httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body)), mgr))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for malformed UUID on %s %s (%s), got %d: %s", tc.method, tc.path, tc.body, rec.Code, rec.Body.String())
		}
	}
}

func TestM3_EndToEnd_Pipelines_Leads_CAS_Bulk_Links_Tasks_Products(t *testing.T) {
	pool := connectTestDB(t)
	defer pool.Close()
	ctx := context.Background()

	if err := db.RunMigrations(ctx, pool, "../../migrations"); err != nil {
		t.Fatalf("migrations failed: %v", err)
	}

	var orgA, orgB, userA string
	_ = pool.QueryRow(ctx, `INSERT INTO organizations (name, slug) VALUES ('M3 Org A', 'm3a-' || substr(md5(random()::text),1,6)) RETURNING id`).Scan(&orgA)
	_ = pool.QueryRow(ctx, `INSERT INTO organizations (name, slug) VALUES ('M3 Org B', 'm3b-' || substr(md5(random()::text),1,6)) RETURNING id`).Scan(&orgB)
	defer pool.Exec(ctx, `DELETE FROM organizations WHERE id IN ($1, $2)`, orgA, orgB)

	_ = pool.QueryRow(ctx, `INSERT INTO users (email, password_hash, full_name) VALUES ('m3-'||substr(md5(random()::text),1,6)||'@t.com', 'x', 'Manager') RETURNING id`).Scan(&userA)
	defer pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userA)

	var contactA string
	_ = pool.QueryRow(ctx, `INSERT INTO contacts (organization_id, name, phone_number) VALUES ($1, 'Carlos M3', '+5511999991111') RETURNING id`, orgA).Scan(&contactA)

	h := &crm.Handler{Pool: pool}
	r := setupM3Router(h)

	mgrA := auth.Identity{UserID: userA, OrganizationID: orgA, Role: "manager"}
	mgrB := auth.Identity{UserID: userA, OrganizationID: orgB, Role: "manager"}

	// 1. CreatePipeline with fields_schema and is_default
	recP := httptest.NewRecorder()
	r.ServeHTTP(recP, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/pipelines", strings.NewReader(`{
		"name":"Ventas M3",
		"pipeline_type":"sales",
		"is_default":true,
		"fields_schema":[{"key":"empresa","label":"Empresa","type":"text"}]
	}`)), mgrA))
	if recP.Code != http.StatusCreated {
		t.Fatalf("CreatePipeline expected 201, got %d: %s", recP.Code, recP.Body.String())
	}
	var pipeResp map[string]any
	_ = json.Unmarshal(recP.Body.Bytes(), &pipeResp)
	pipeID := pipeResp["id"].(string)
	stages := pipeResp["stages"].([]any)
	if len(stages) < 2 {
		t.Fatalf("expected seeded stages, got %d", len(stages))
	}
	stage1ID := stages[0].(map[string]any)["id"].(string)
	stageWonID := ""
	for _, s := range stages {
		sm := s.(map[string]any)
		if sm["is_won"] == true {
			stageWonID = sm["id"].(string)
		}
	}

	// Cross-tenant UpdatePipeline -> 404
	recPB := httptest.NewRecorder()
	r.ServeHTTP(recPB, withIdentity(httptest.NewRequest(http.MethodPatch, "/api/v1/pipelines/"+pipeID, strings.NewReader(`{"name":"Hacked"}`)), mgrB))
	if recPB.Code != http.StatusNotFound {
		t.Fatalf("expected 404 cross-tenant UpdatePipeline, got %d", recPB.Code)
	}

	// Create extra stage & delete it when empty
	recSt := httptest.NewRecorder()
	r.ServeHTTP(recSt, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/pipelines/"+pipeID+"/stages", strings.NewReader(`{"name":"Temp Stage","requires_human":true}`)), mgrA))
	if recSt.Code != http.StatusCreated {
		t.Fatalf("CreateStage expected 201, got %d: %s", recSt.Code, recSt.Body.String())
	}
	var stResp map[string]any
	_ = json.Unmarshal(recSt.Body.Bytes(), &stResp)
	tempStageID := stResp["id"].(string)

	// 2. Create two leads
	recL1 := httptest.NewRecorder()
	r.ServeHTTP(recL1, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/leads", strings.NewReader(fmt.Sprintf(`{
		"contact_id":"%s","pipeline_id":"%s","stage_id":"%s","title":"Deal Uno","value_cents":50000,"custom_fields":{"empresa":"Acme"}
	}`, contactA, pipeID, stage1ID))), mgrA))
	if recL1.Code != http.StatusCreated {
		t.Fatalf("CreateLead 1 expected 201, got %d: %s", recL1.Code, recL1.Body.String())
	}
	var l1Resp map[string]any
	_ = json.Unmarshal(recL1.Body.Bytes(), &l1Resp)
	lead1ID := l1Resp["id"].(string)

	recL2 := httptest.NewRecorder()
	r.ServeHTTP(recL2, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/leads", strings.NewReader(fmt.Sprintf(`{
		"contact_id":"%s","pipeline_id":"%s","stage_id":"%s","title":"Deal Dos","value_cents":25000
	}`, contactA, pipeID, stage1ID))), mgrA))
	if recL2.Code != http.StatusCreated {
		t.Fatalf("CreateLead 2 expected 201, got %d: %s", recL2.Code, recL2.Body.String())
	}
	var l2Resp map[string]any
	_ = json.Unmarshal(recL2.Body.Bytes(), &l2Resp)
	lead2ID := l2Resp["id"].(string)

	// DeleteStage with existing leads -> 422
	recDelStageFail := httptest.NewRecorder()
	r.ServeHTTP(recDelStageFail, withIdentity(httptest.NewRequest(http.MethodDelete, "/api/v1/stages/"+stage1ID, nil), mgrA))
	if recDelStageFail.Code != http.StatusUnprocessableEntity {
		t.Fatalf("DeleteStage with leads expected 422, got %d", recDelStageFail.Code)
	}

	// Delete empty temp stage -> 200
	recDelStageOK := httptest.NewRecorder()
	r.ServeHTTP(recDelStageOK, withIdentity(httptest.NewRequest(http.MethodDelete, "/api/v1/stages/"+tempStageID, nil), mgrA))
	if recDelStageOK.Code != http.StatusOK {
		t.Fatalf("DeleteStage empty expected 200, got %d", recDelStageOK.Code)
	}

	// 3. Atomic 409 CAS on UpdateLead
	recUpdOK := httptest.NewRecorder()
	r.ServeHTTP(recUpdOK, withIdentity(httptest.NewRequest(http.MethodPatch, "/api/v1/leads/"+lead1ID, strings.NewReader(fmt.Sprintf(`{"stage_id":"%s","version":1}`, stageWonID))), mgrA))
	if recUpdOK.Code != http.StatusOK {
		t.Fatalf("UpdateLead CAS expected 200, got %d: %s", recUpdOK.Code, recUpdOK.Body.String())
	}
	// Stale version=1 -> 409 with version_conflict and current_version=2
	recUpdConflict := httptest.NewRecorder()
	r.ServeHTTP(recUpdConflict, withIdentity(httptest.NewRequest(http.MethodPatch, "/api/v1/leads/"+lead1ID, strings.NewReader(`{"title":"Stale","version":1}`)), mgrA))
	if recUpdConflict.Code != http.StatusConflict || !strings.Contains(recUpdConflict.Body.String(), "version_conflict") {
		t.Fatalf("UpdateLead stale CAS expected 409 version_conflict, got %d: %s", recUpdConflict.Code, recUpdConflict.Body.String())
	}

	// 4. BulkMoveLeads > 50 -> 422
	ids51 := make([]string, 51)
	for i := range ids51 {
		ids51[i] = lead1ID
	}
	bulkBody51, _ := json.Marshal(map[string]any{"lead_ids": ids51, "stage_id": stage1ID})
	recBulk51 := httptest.NewRecorder()
	r.ServeHTTP(recBulk51, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/leads/bulk", strings.NewReader(string(bulkBody51))), mgrA))
	if recBulk51.Code != http.StatusUnprocessableEntity {
		t.Fatalf("BulkMoveLeads > 50 expected 422, got %d: %s", recBulk51.Code, recBulk51.Body.String())
	}

	// 5. Lead Links & Activities & Attachments & GetLead
	recSelfLink := httptest.NewRecorder()
	r.ServeHTTP(recSelfLink, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/leads/"+lead1ID+"/links", strings.NewReader(fmt.Sprintf(`{"target_lead_id":"%s","link_type":"related"}`, lead1ID))), mgrA))
	if recSelfLink.Code != http.StatusUnprocessableEntity {
		t.Fatalf("self link expected 422, got %d", recSelfLink.Code)
	}

	recLink := httptest.NewRecorder()
	r.ServeHTTP(recLink, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/leads/"+lead1ID+"/links", strings.NewReader(fmt.Sprintf(`{"target_lead_id":"%s","link_type":"blocks"}`, lead2ID))), mgrA))
	if recLink.Code != http.StatusCreated {
		t.Fatalf("CreateLeadLink expected 201, got %d: %s", recLink.Code, recLink.Body.String())
	}
	var linkResp map[string]any
	_ = json.Unmarshal(recLink.Body.Bytes(), &linkResp)
	linkID := linkResp["id"].(string)

	recAct := httptest.NewRecorder()
	r.ServeHTTP(recAct, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/leads/"+lead1ID+"/activities", strings.NewReader(`{"type":"note","summary":"Llamada de seguimiento"}`)), mgrA))
	if recAct.Code != http.StatusCreated {
		t.Fatalf("CreateLeadActivity expected 201, got %d", recAct.Code)
	}

	recAtt := httptest.NewRecorder()
	r.ServeHTTP(recAtt, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/leads/"+lead1ID+"/attachments", strings.NewReader(`{"file_name":"propuesta.pdf","file_url":"https://files.example.com/propuesta.pdf","size_bytes":1024}`)), mgrA))
	if recAtt.Code != http.StatusCreated {
		t.Fatalf("CreateLeadAttachment expected 201, got %d", recAtt.Code)
	}

	recGetLead := httptest.NewRecorder()
	r.ServeHTTP(recGetLead, withIdentity(httptest.NewRequest(http.MethodGet, "/api/v1/leads/"+lead1ID, nil), mgrA))
	if recGetLead.Code != http.StatusOK {
		t.Fatalf("GetLead expected 200, got %d", recGetLead.Code)
	}
	var glResp map[string]any
	_ = json.Unmarshal(recGetLead.Body.Bytes(), &glResp)
	if glResp["status"] != "won" || len(glResp["links"].([]any)) != 1 || len(glResp["attachments"].([]any)) != 1 || len(glResp["activities"].([]any)) < 2 {
		t.Fatalf("GetLead missing expected nested data: %+v", glResp)
	}

	// Delete link
	recDelLink := httptest.NewRecorder()
	r.ServeHTTP(recDelLink, withIdentity(httptest.NewRequest(http.MethodDelete, "/api/v1/leads/"+lead1ID+"/links/"+linkID, nil), mgrA))
	if recDelLink.Code != http.StatusOK {
		t.Fatalf("DeleteLeadLink expected 200, got %d", recDelLink.Code)
	}

	// 6. Tasks & Task Plans
	recTask := httptest.NewRecorder()
	r.ServeHTTP(recTask, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/tasks", strings.NewReader(`{"title":"Enviar contrato","due_at":"2025-01-01T10:00:00Z","recurrence":"weekly"}`)), mgrA))
	if recTask.Code != http.StatusCreated {
		t.Fatalf("CreateTask expected 201, got %d: %s", recTask.Code, recTask.Body.String())
	}
	var taskResp map[string]any
	_ = json.Unmarshal(recTask.Body.Bytes(), &taskResp)
	taskID := taskResp["id"].(string)

	recListOverdue := httptest.NewRecorder()
	r.ServeHTTP(recListOverdue, withIdentity(httptest.NewRequest(http.MethodGet, "/api/v1/tasks?status=overdue", nil), mgrA))
	if recListOverdue.Code != http.StatusOK || !strings.Contains(recListOverdue.Body.String(), taskID) {
		t.Fatalf("expected overdue task in filter, got %d: %s", recListOverdue.Code, recListOverdue.Body.String())
	}

	recDelTask := httptest.NewRecorder()
	r.ServeHTTP(recDelTask, withIdentity(httptest.NewRequest(http.MethodDelete, "/api/v1/tasks/"+taskID, nil), mgrA))
	if recDelTask.Code != http.StatusOK {
		t.Fatalf("DeleteTask expected 200, got %d", recDelTask.Code)
	}

	recPlan := httptest.NewRecorder()
	r.ServeHTTP(recPlan, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/task-plans", strings.NewReader(`{
		"name":"Onboarding Cliente","items":[{"title":"Bienvenida","offset_days":1,"recurrence":""},{"title":"Revisión","offset_days":7,"recurrence":"monthly"}]
	}`)), mgrA))
	if recPlan.Code != http.StatusCreated {
		t.Fatalf("CreateTaskPlan expected 201, got %d: %s", recPlan.Code, recPlan.Body.String())
	}
	var planResp map[string]any
	_ = json.Unmarshal(recPlan.Body.Bytes(), &planResp)
	planID := planResp["id"].(string)

	recApply := httptest.NewRecorder()
	r.ServeHTTP(recApply, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/task-plans/"+planID+"/apply", strings.NewReader(fmt.Sprintf(`{"lead_id":"%s"}`, lead1ID))), mgrA))
	if recApply.Code != http.StatusCreated || !strings.Contains(recApply.Body.String(), `"created":2`) {
		t.Fatalf("ApplyTaskPlan expected 201 created:2, got %d: %s", recApply.Code, recApply.Body.String())
	}

	// Empty-string UUID handling & cross-tenant reference checks
	recLeadEmptyOwner := httptest.NewRecorder()
	r.ServeHTTP(recLeadEmptyOwner, withIdentity(httptest.NewRequest(http.MethodPatch, "/api/v1/leads/"+lead1ID, strings.NewReader(`{"owner_user_id":""}`)), mgrA))
	if recLeadEmptyOwner.Code != http.StatusOK {
		t.Fatalf("UpdateLead empty owner_user_id expected 200, got %d: %s", recLeadEmptyOwner.Code, recLeadEmptyOwner.Body.String())
	}

	recTaskEmptyUUIDs := httptest.NewRecorder()
	r.ServeHTTP(recTaskEmptyUUIDs, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/tasks", strings.NewReader(`{"title":"Empty UUIDs","lead_id":"","contact_id":"","assigned_to":""}`)), mgrA))
	if recTaskEmptyUUIDs.Code != http.StatusCreated {
		t.Fatalf("CreateTask empty UUIDs expected 201, got %d: %s", recTaskEmptyUUIDs.Code, recTaskEmptyUUIDs.Body.String())
	}
	var emptyTaskResp map[string]any
	_ = json.Unmarshal(recTaskEmptyUUIDs.Body.Bytes(), &emptyTaskResp)
	recTaskUpdEmpty := httptest.NewRecorder()
	r.ServeHTTP(recTaskUpdEmpty, withIdentity(httptest.NewRequest(http.MethodPatch, "/api/v1/tasks/"+emptyTaskResp["id"].(string), strings.NewReader(`{"assigned_to":""}`)), mgrA))
	if recTaskUpdEmpty.Code != http.StatusOK {
		t.Fatalf("UpdateTask empty assigned_to expected 200, got %d: %s", recTaskUpdEmpty.Code, recTaskUpdEmpty.Body.String())
	}

	recCrossTask := httptest.NewRecorder()
	r.ServeHTTP(recCrossTask, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/tasks", strings.NewReader(fmt.Sprintf(`{"title":"Cross","lead_id":"%s"}`, lead1ID))), mgrB))
	if recCrossTask.Code != http.StatusNotFound {
		t.Fatalf("CreateTask cross-tenant lead_id expected 404, got %d: %s", recCrossTask.Code, recCrossTask.Body.String())
	}

	// 7. Products CRUD & validation
	recProdNeg := httptest.NewRecorder()
	r.ServeHTTP(recProdNeg, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/products", strings.NewReader(`{"name":"Bad","price_cents":-10}`)), mgrA))
	if recProdNeg.Code != http.StatusUnprocessableEntity {
		t.Fatalf("CreateProduct negative price expected 422, got %d", recProdNeg.Code)
	}

	recProdOK := httptest.NewRecorder()
	r.ServeHTTP(recProdOK, withIdentity(httptest.NewRequest(http.MethodPost, "/api/v1/products", strings.NewReader(`{"sku":"CRM-01","name":"Plan Pro","category":"saas","price_cents":9900,"stock_qty":100}`)), mgrA))
	if recProdOK.Code != http.StatusCreated {
		t.Fatalf("CreateProduct expected 201, got %d: %s", recProdOK.Code, recProdOK.Body.String())
	}
	var prodResp map[string]any
	_ = json.Unmarshal(recProdOK.Body.Bytes(), &prodResp)
	prodID := prodResp["id"].(string)

	recProdPatch := httptest.NewRecorder()
	r.ServeHTTP(recProdPatch, withIdentity(httptest.NewRequest(http.MethodPatch, "/api/v1/products/"+prodID, strings.NewReader(`{"price_cents":12900,"is_active":false}`)), mgrA))
	if recProdPatch.Code != http.StatusOK {
		t.Fatalf("UpdateProduct expected 200, got %d", recProdPatch.Code)
	}

	recProdDel := httptest.NewRecorder()
	r.ServeHTTP(recProdDel, withIdentity(httptest.NewRequest(http.MethodDelete, "/api/v1/products/"+prodID, nil), mgrA))
	if recProdDel.Code != http.StatusOK {
		t.Fatalf("DeleteProduct expected 200, got %d", recProdDel.Code)
	}
}
