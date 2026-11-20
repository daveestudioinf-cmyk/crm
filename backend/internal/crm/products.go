package crm

import (
	"errors"
	"net/http"
	"strings"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/httpx"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
)

func (h *Handler) ListProducts(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	category := strings.TrimSpace(r.URL.Query().Get("category"))
	activeParam := strings.TrimSpace(r.URL.Query().Get("active"))

	var activeFilter *bool
	if activeParam == "true" {
		v := true
		activeFilter = &v
	} else if activeParam == "false" {
		v := false
		activeFilter = &v
	}

	rows, err := h.Pool.Query(r.Context(), `
		SELECT id, COALESCE(sku,''), name, COALESCE(description,''), COALESCE(category,'general'),
		       price_cents, currency, stock_qty, is_active, created_at, updated_at
		FROM catalog_products
		WHERE organization_id = $1
		  AND ($2 = '' OR name ILIKE '%' || $2 || '%' OR COALESCE(sku,'') ILIKE '%' || $2 || '%')
		  AND ($3 = '' OR category = $3)
		  AND ($4::boolean IS NULL OR is_active = $4)
		ORDER BY created_at DESC
	`, id.OrganizationID, q, category, activeFilter)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var pid, sku, name, desc, cat, curr string
		var price int64
		var stock int
		var isActive bool
		var createdAt, updatedAt any
		_ = rows.Scan(&pid, &sku, &name, &desc, &cat, &price, &curr, &stock, &isActive, &createdAt, &updatedAt)
		out = append(out, map[string]any{
			"id": pid, "sku": sku, "name": name, "description": desc, "category": cat,
			"price_cents": price, "currency": curr, "stock_qty": stock, "is_active": isActive,
			"created_at": createdAt, "updated_at": updatedAt,
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (h *Handler) CreateProduct(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		SKU         string `json:"sku"`
		Name        string `json:"name"`
		Description string `json:"description"`
		Category    string `json:"category"`
		PriceCents  int64  `json:"price_cents"`
		Currency    string `json:"currency"`
		StockQty    int    `json:"stock_qty"`
		IsActive    *bool  `json:"is_active"`
	}
	if err := httpx.Decode(r, &req); err != nil || strings.TrimSpace(req.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "name required")
		return
	}
	if req.PriceCents < 0 || req.StockQty < 0 {
		httpx.Error(w, http.StatusUnprocessableEntity, "price_cents and stock_qty must be non-negative")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	req.SKU = strings.TrimSpace(req.SKU)
	req.Category = strings.TrimSpace(req.Category)
	if req.Category == "" {
		req.Category = "general"
	}
	req.Currency = strings.TrimSpace(req.Currency)
	if req.Currency == "" {
		req.Currency = "USD"
	}
	isActive := true
	if req.IsActive != nil {
		isActive = *req.IsActive
	}

	if req.SKU != "" {
		var dupID string
		if err := h.Pool.QueryRow(r.Context(), `
			SELECT id FROM catalog_products WHERE organization_id = $1 AND sku = $2 LIMIT 1
		`, id.OrganizationID, req.SKU).Scan(&dupID); err == nil {
			httpx.Error(w, http.StatusConflict, "duplicate sku")
			return
		}
	}

	var pid string
	err := h.Pool.QueryRow(r.Context(), `
		INSERT INTO catalog_products (organization_id, sku, name, description, category, price_cents, currency, stock_qty, is_active)
		VALUES ($1, NULLIF($2,''), $3, $4, $5, $6, $7, $8, $9) RETURNING id
	`, id.OrganizationID, req.SKU, req.Name, req.Description, req.Category, req.PriceCents, req.Currency, req.StockQty, isActive).Scan(&pid)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "db error")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "product.create", "product", pid, map[string]any{"name": req.Name, "sku": req.SKU})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": pid, "sku": req.SKU, "name": req.Name, "description": req.Description,
		"category": req.Category, "price_cents": req.PriceCents, "currency": req.Currency,
		"stock_qty": req.StockQty, "is_active": isActive,
	})
}

func (h *Handler) UpdateProduct(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	pid := chi.URLParam(r, "id")
	var req struct {
		SKU         *string `json:"sku"`
		Name        *string `json:"name"`
		Description *string `json:"description"`
		Category    *string `json:"category"`
		PriceCents  *int64  `json:"price_cents"`
		Currency    *string `json:"currency"`
		StockQty    *int    `json:"stock_qty"`
		IsActive    *bool   `json:"is_active"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.PriceCents != nil && *req.PriceCents < 0 {
		httpx.Error(w, http.StatusUnprocessableEntity, "price_cents must be non-negative")
		return
	}
	if req.StockQty != nil && *req.StockQty < 0 {
		httpx.Error(w, http.StatusUnprocessableEntity, "stock_qty must be non-negative")
		return
	}
	if req.Name != nil && strings.TrimSpace(*req.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "name cannot be empty")
		return
	}

	var retID, retSKU, retName, retDesc, retCat, retCurr string
	var retPrice int64
	var retStock int
	var retActive bool
	err := h.Pool.QueryRow(r.Context(), `
		UPDATE catalog_products SET
			sku = COALESCE($3, sku),
			name = COALESCE($4, name),
			description = COALESCE($5, description),
			category = COALESCE($6, category),
			price_cents = COALESCE($7, price_cents),
			currency = COALESCE($8, currency),
			stock_qty = COALESCE($9, stock_qty),
			is_active = COALESCE($10, is_active),
			updated_at = now()
		WHERE id = $1 AND organization_id = $2
		RETURNING id, COALESCE(sku,''), name, COALESCE(description,''), category, price_cents, currency, stock_qty, is_active
	`, pid, id.OrganizationID, req.SKU, req.Name, req.Description, req.Category, req.PriceCents, req.Currency, req.StockQty, req.IsActive).Scan(
		&retID, &retSKU, &retName, &retDesc, &retCat, &retPrice, &retCurr, &retStock, &retActive,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "product not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "update failed")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "product.update", "product", pid, map[string]any{"updated": true})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"status": "updated", "id": retID, "sku": retSKU, "name": retName, "description": retDesc,
		"category": retCat, "price_cents": retPrice, "currency": retCurr, "stock_qty": retStock, "is_active": retActive,
	})
}

func (h *Handler) DeleteProduct(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	pid := chi.URLParam(r, "id")
	tag, err := h.Pool.Exec(r.Context(), `DELETE FROM catalog_products WHERE id = $1 AND organization_id = $2`, pid, id.OrganizationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "delete failed")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(w, http.StatusNotFound, "product not found")
		return
	}
	_ = auth.WriteAudit(r.Context(), h.Pool, id, "product.delete", "product", pid, map[string]any{})
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
