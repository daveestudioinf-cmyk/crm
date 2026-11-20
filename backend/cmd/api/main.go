package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/admin"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/ai"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/auth"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/automation"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/config"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/crm"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/db"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/httpx"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/inbox"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/mcpserver"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/realtime"
	"github.com/daveestudioinf-cmyk/crm-go/backend/internal/whatsapp"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/redis/go-redis/v9"
)

func main() {
	cfg := config.Load()
	ctx := context.Background()

	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	defer pool.Close()

	if err := db.RunMigrations(ctx, pool, "migrations"); err != nil {
		log.Fatalf("migrations failed: %v", err)
	}

	var rdb *redis.Client
	if cfg.RedisURL != "" {
		if opt, err := redis.ParseURL(cfg.RedisURL); err == nil {
			rdb = redis.NewClient(opt)
		}
	}

	evoClient := whatsapp.NewEvolutionClient(cfg.EvolutionURL, cfg.EvolutionAPIKey)
	hub := realtime.NewHub(cfg.RedisURL)
	authMw := &auth.Middleware{Pool: pool, JWTSecret: cfg.JWTSecret}
	authH := &auth.Handler{Pool: pool, Cfg: cfg}
	adminH := &admin.Handler{Pool: pool}
	crmH := &crm.Handler{Pool: pool, Hub: hub}
	waH := &whatsapp.Handler{Pool: pool, Hub: hub, RDB: rdb, Evolution: evoClient, PublicAPIURL: cfg.PublicAPIURL}
	inboxH := &inbox.Handler{Pool: pool, Hub: hub, Evolution: evoClient, Throttle: waH, Cfg: cfg}
	aiH := &ai.Handler{Pool: pool, Hub: hub, EncryptionKey: cfg.AIEncryptionKey}
	autoH := &automation.Handler{Pool: pool}
	mcpSrv := &mcpserver.Server{Pool: pool}

	r := chi.NewRouter()
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{cfg.FrontendOrigin, "http://localhost:5173", "http://127.0.0.1:5173"},
		AllowedMethods:   []string{"GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-Organization-ID", "X-Support-Session-ID", "Idempotency-Key"},
		AllowCredentials: true,
	}))

	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		httpx.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	r.Route("/api/v1", func(r chi.Router) {
		// Public Auth & Webhooks
		r.Post("/auth/signup", authH.Signup)
		r.Post("/auth/login", authH.Login)
		r.Post("/auth/forgot", authH.ForgotPassword)
		r.Post("/auth/reset", authH.ResetPassword)
		r.Post("/auth/mfa/verify", authH.VerifyMFA)
		r.Post("/auth/refresh", authH.Refresh)
		r.Post("/auth/logout", authH.Logout)
		r.Get("/team/invites/{token}", authH.InspectInvite)
		r.Post("/team/accept-invite", authH.AcceptInvite)
		r.Post("/webhooks/waha/{session}", waH.WAHAWebhook)
		r.Post("/webhooks/evolution/{session}", waH.EvolutionWebhook)
		r.Post("/webhooks/in/{token}", autoH.InboundLeadCapture)

		// Platform Admin Routes (isolated from RequireTenantAccess and X-Support-Session-ID)
		r.Route("/admin", func(r chi.Router) {
			r.Use(authMw.Authenticate)
			r.Use(authMw.RequirePlatformAdmin)

			r.Get("/tenants", adminH.ListTenants)
			r.Patch("/tenants/{id}", adminH.UpdateTenantStatus)
			r.Post("/support-sessions", adminH.StartSupportSession)
			r.Post("/support-sessions/{id}/end", adminH.EndSupportSession)
			r.Get("/metrics", adminH.GetMetrics)
		})

		// Authenticated User Profile (accessible even if the user's home tenant is suspended)
		r.Group(func(r chi.Router) {
			r.Use(authMw.Authenticate)
			r.Get("/auth/me", authH.Me)
			r.Patch("/auth/me", authH.UpdateMe)
		})

		// Protected Tenant Routes
		r.Group(func(r chi.Router) {
			r.Use(authMw.Authenticate)
			r.Use(authMw.RequireTenantAccess)
			r.Use(authMw.Idempotency)

			r.Post("/auth/mfa/setup", authH.SetupMFA)
			r.Post("/auth/mfa/enable", authH.EnableMFA)
			r.Post("/auth/mfa/recovery-codes", authH.RegenerateRecoveryCodes)
			r.Post("/auth/mfa/disable", authH.DisableMFA)

			r.Get("/api-tokens", authH.ListAPITokens)
			r.Group(func(r chi.Router) {
				r.Use(auth.RequireRole("admin"))
				r.Post("/api-tokens", authH.CreateAPIToken)
				r.Delete("/api-tokens/{id}", authH.RevokeAPIToken)
			})

			r.Get("/organization", authH.GetOrganization)
			r.With(auth.RequireRole("admin")).Patch("/organization", authH.UpdateOrganization)

			r.Group(func(r chi.Router) {
				r.Use(auth.RequireRole("manager"))
				r.Get("/team/invites", authH.ListInvites)
				r.Post("/team/invites", authH.CreateInvite)
				r.Delete("/team/invites/{id}", authH.RevokeInvite)
			})
			r.Patch("/team/members/{id}", authH.UpdateMember)
			r.With(auth.RequireRole("admin")).Delete("/team/members/{id}", authH.RemoveMember)

			r.Get("/realtime/stream", func(w http.ResponseWriter, r *http.Request) {
				id, _ := auth.FromContext(r.Context())
				hub.ServeSSE(w, r, id.OrganizationID)
			})

			// Native HTTP MCP endpoint (rejects support sessions explicitly)
			r.Post("/mcp", func(w http.ResponseWriter, r *http.Request) {
				if id, ok := auth.FromContext(r.Context()); ok && id.SupportSessID != "" {
					httpx.Error(w, http.StatusForbidden, "support_session_not_allowed")
					return
				}
				mcpSrv.ServeHTTP(w, r)
			})

			// Contacts & Merge Queue
			r.Get("/contacts", crmH.ListContacts)
			r.Get("/contacts/merge-queue", crmH.ListMergeQueue)
			r.Get("/contacts/{id}", crmH.GetContact)
			r.Group(func(r chi.Router) {
				r.Use(auth.RequireRole("agent"))
				r.Post("/contacts", crmH.CreateContact)
				r.Post("/contacts/merge-queue/{id}/dismiss", crmH.DismissMergeQueue)
				r.Post("/contacts/merge", crmH.MergeContacts)
				r.Patch("/contacts/{id}", crmH.UpdateContact)
				r.Post("/contacts/{id}/phones", crmH.AddContactPhone)
				r.Delete("/contacts/{id}/phones/{phoneId}", crmH.DeleteContactPhone)
			})

			// Pipelines, Stages & Leads
			r.Get("/pipelines", crmH.ListPipelines)
			r.Get("/leads", crmH.ListLeads)
			r.Get("/leads/{id}", crmH.GetLead)
			r.Group(func(r chi.Router) {
				r.Use(auth.RequireRole("agent"))
				r.Post("/leads", crmH.CreateLead)
				r.Patch("/leads/{id}", crmH.UpdateLead)
				r.Delete("/leads/{id}", crmH.DeleteLead)
				r.Post("/leads/bulk", crmH.BulkMoveLeads)
				r.Post("/leads/{id}/links", crmH.CreateLeadLink)
				r.Delete("/leads/{id}/links/{linkId}", crmH.DeleteLeadLink)
				r.Post("/leads/{id}/activities", crmH.CreateLeadActivity)
				r.Post("/leads/{id}/attachments", crmH.CreateLeadAttachment)
				r.Delete("/leads/{id}/attachments/{attId}", crmH.DeleteLeadAttachment)
			})
			r.Group(func(r chi.Router) {
				r.Use(auth.RequireRole("manager"))
				r.Post("/pipelines", crmH.CreatePipeline)
				r.Patch("/pipelines/{id}", crmH.UpdatePipeline)
				r.Post("/pipelines/{id}/stages", crmH.CreateStage)
				r.Post("/stages", crmH.CreateStage)
				r.Patch("/stages/{id}", crmH.UpdateStage)
				r.Delete("/stages/{id}", crmH.DeleteStage)
			})

			// Tasks, Task Plans & Products
			r.Get("/tasks", crmH.ListTasks)
			r.Get("/task-plans", crmH.ListTaskPlans)
			r.Group(func(r chi.Router) {
				r.Use(auth.RequireRole("agent"))
				r.Post("/tasks", crmH.CreateTask)
				r.Patch("/tasks/{id}", crmH.UpdateTask)
				r.Delete("/tasks/{id}", crmH.DeleteTask)
				r.Post("/task-plans", crmH.CreateTaskPlan)
				r.Delete("/task-plans/{id}", crmH.DeleteTaskPlan)
				r.Post("/task-plans/{id}/apply", crmH.ApplyTaskPlan)
			})
			r.Get("/products", crmH.ListProducts)
			r.Group(func(r chi.Router) {
				r.Use(auth.RequireRole("manager"))
				r.Post("/products", crmH.CreateProduct)
				r.Patch("/products/{id}", crmH.UpdateProduct)
				r.Delete("/products/{id}", crmH.DeleteProduct)
			})

			// Inbox, Conversations, Messages, Media & Templates
			r.Get("/conversations", inboxH.ListConversations)
			r.Get("/conversations/{id}/messages", inboxH.ListMessages)
			r.Get("/media/{id}", inboxH.GetMedia)
			r.Get("/templates", inboxH.ListTemplates)
			r.Get("/radar", inboxH.Radar)
			r.Group(func(r chi.Router) {
				r.Use(auth.RequireRole("agent"))
				r.Post("/conversations", inboxH.CreateConversation)
				r.Post("/conversations/{id}/claim", inboxH.ClaimConversation)
				r.Post("/conversations/{id}/transfer", inboxH.TransferConversation)
				r.Post("/conversations/{id}/resolve", inboxH.ResolveConversation)
				r.Post("/conversations/{id}/messages", inboxH.SendMessage)
				r.Post("/media/upload", inboxH.UploadMedia)
				r.Post("/templates", inboxH.CreateTemplate)
				r.Patch("/templates/{id}", inboxH.UpdateTemplate)
				r.Delete("/templates/{id}", inboxH.DeleteTemplate)
			})

			// Channels (WhatsApp)
			r.Get("/channels", waH.ListChannels)
			r.Get("/channels/{id}/qr", waH.GetQR)
			r.Group(func(r chi.Router) {
				r.Use(auth.RequireRole("manager"))
				r.Post("/channels", waH.CreateChannel)
				r.Patch("/channels/{id}", waH.UpdateChannel)
				r.Post("/channels/{id}/reconnect", waH.ReconnectChannel)
				r.Post("/channels/{id}/disconnect", waH.DisconnectChannel)
				r.Delete("/channels/{id}", waH.DeleteChannel)
			})

			// AI Agents, Providers, Budgets, Runs, Knowledge (RAG) & Memory
			r.Get("/ai/agents", aiH.ListAgents)
			r.Get("/ai/providers", aiH.ListProviders)
			r.Get("/ai/budget", aiH.GetBudget)
			r.Get("/ai/usage", aiH.GetUsage)
			r.Get("/ai/runs", aiH.ListRuns)
			r.Get("/ai/memory", aiH.ListMemory)
			r.Get("/ai/knowledge", aiH.ListKnowledge)
			r.Post("/ai/knowledge/search", aiH.SearchKnowledge)
			r.Group(func(r chi.Router) {
				r.Use(auth.RequireRole("manager"))
				r.Post("/ai/agents", aiH.CreateAgent)
				r.Patch("/ai/agents/{id}", aiH.UpdateAgent)
				r.Post("/ai/providers", aiH.UpsertProvider)
				r.Delete("/ai/providers/{id}", aiH.DeleteProvider)
				r.Put("/ai/budget", aiH.UpdateBudget)
				r.Post("/ai/memory", aiH.CreateMemory)
				r.Delete("/ai/memory/{id}", aiH.DeleteMemory)
				r.Post("/ai/knowledge", aiH.CreateKnowledge)
				r.Delete("/ai/knowledge/{id}", aiH.DeleteKnowledge)
			})

			// Webhooks, Automations, LGPD, Team, Audit, Metrics
			r.Get("/webhooks/sources", autoH.ListWebhookSources)
			r.Post("/webhooks/sources", autoH.CreateWebhookSource)
			r.Get("/automations", autoH.ListRules)
			r.Post("/automations", autoH.CreateRule)
			r.Get("/lgpd/requests", autoH.ListLGPDRequests)
			r.Post("/lgpd/requests", autoH.CreateLGPDRequest)
			r.Group(func(r chi.Router) {
				r.Use(auth.RequireRole("manager"))
				r.Post("/lgpd/requests/{id}/execute", autoH.ExecuteLGPDRequest)
				r.Post("/lgpd/requests/{id}/reject", autoH.RejectLGPDRequest)
			})
			r.Get("/team", autoH.ListTeam)
			r.Get("/audit", autoH.ListAudit)
			r.Get("/metrics", autoH.GetMetrics)
		})
	})

	srv := &http.Server{Addr: ":" + cfg.Port, Handler: r}
	go func() {
		log.Printf("KoraCRM API listening on :%s", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutCtx)
}
