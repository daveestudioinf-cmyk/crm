package realtime

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

type Event struct {
	OrganizationID string `json:"organization_id"`
	Type           string `json:"type"`
	Payload        any    `json:"payload"`
	Timestamp      string `json:"timestamp"`
}

type Hub struct {
	mu      sync.RWMutex
	clients map[string]map[chan Event]struct{}
	rdb     *redis.Client
}

func NewHub(redisURL string) *Hub {
	h := &Hub{
		clients: make(map[string]map[chan Event]struct{}),
	}
	if redisURL != "" {
		if opt, err := redis.ParseURL(redisURL); err == nil {
			h.rdb = redis.NewClient(opt)
			go h.listenRedis()
		}
	}
	return h
}

func (h *Hub) listenRedis() {
	if h.rdb == nil {
		return
	}
	ctx := context.Background()
	sub := h.rdb.PSubscribe(ctx, "crm:realtime:*")
	defer sub.Close()
	for msg := range sub.Channel() {
		var ev Event
		if err := json.Unmarshal([]byte(msg.Payload), &ev); err == nil {
			h.dispatchLocal(ev)
		}
	}
}

func (h *Hub) Publish(orgID, evType string, payload any) {
	ev := Event{
		OrganizationID: orgID,
		Type:           evType,
		Payload:        payload,
		Timestamp:      time.Now().UTC().Format(time.RFC3339),
	}
	if h.rdb != nil {
		if b, err := json.Marshal(ev); err == nil {
			if err := h.rdb.Publish(context.Background(), "crm:realtime:"+orgID, b).Err(); err == nil {
				return
			}
		}
	}
	h.dispatchLocal(ev)
}

func (h *Hub) dispatchLocal(ev Event) {
	h.mu.RLock()
	subs := h.clients[ev.OrganizationID]
	for ch := range subs {
		select {
		case ch <- ev:
		default:
		}
	}
	h.mu.RUnlock()
}

func (h *Hub) Subscribe(orgID string) (chan Event, func()) {
	ch := make(chan Event, 32)
	h.mu.Lock()
	if h.clients[orgID] == nil {
		h.clients[orgID] = make(map[chan Event]struct{})
	}
	h.clients[orgID][ch] = struct{}{}
	h.mu.Unlock()

	return ch, func() {
		h.mu.Lock()
		if subs := h.clients[orgID]; subs != nil {
			delete(subs, ch)
			if len(subs) == 0 {
				delete(h.clients, orgID)
			}
		}
		h.mu.Unlock()
		close(ch)
	}
}

func (h *Hub) ServeSSE(w http.ResponseWriter, r *http.Request, orgID string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ch, unsub := h.Subscribe(orgID)
	defer unsub()

	fmt.Fprintf(w, "event: connected\ndata: {\"status\":\"ok\"}\n\n")
	flusher.Flush()

	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			fmt.Fprintf(w, ": ping\n\n")
			flusher.Flush()
		case ev, open := <-ch:
			if !open {
				return
			}
			b, _ := json.Marshal(ev)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Type, string(b))
			flusher.Flush()
		}
	}
}
