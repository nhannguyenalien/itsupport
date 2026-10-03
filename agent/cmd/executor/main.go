// The privileged executor. This is the ONLY process in the agent meant to run
// elevated (installed as a Windows service under a privileged account — that
// service installation/manifest is not written yet, tracked separately from
// this code). It listens on loopback only, verifies an HMAC signature on every
// request before parsing anything, and refuses any tool name outside the
// compile-time allowlist (internal/executor). See docs/v0.1-spec.md's process
// separation diagram and "Executor chỉ nhận message đã verify signature/schema".
package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"support-agent/agent/internal/version"
	"time"

	"support-agent/agent/internal/executor"
	"support-agent/agent/internal/ipc"
	"support-agent/agent/internal/winsvc"
)

func main() {
	version.PrintIfRequested()
	if err := winsvc.RunAsService("SupportAgentExecutor", run); err != nil {
		log.Fatal(err)
	}
}

// run starts the loopback HTTP server and blocks until stopCh is closed, at
// which point it shuts the server down gracefully (existing in-flight
// requests get to finish, no new ones are accepted) — extracted out of
// main() so this can be driven either by the Windows Service Control Manager
// (winsvc.RunAsService) or directly when running interactively for dev/testing.
func run(stopCh <-chan struct{}) {
	secret := os.Getenv("AGENT_IPC_SECRET")
	if secret == "" {
		log.Fatal("AGENT_IPC_SECRET is not set — refusing to start with no shared secret (would accept unsigned requests)")
	}
	secretBytes := []byte(secret)

	addr := ipc.DefaultAddr
	if v := os.Getenv("AGENT_IPC_ADDR"); v != "" {
		addr = v
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/execute", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1MB cap — no request has legitimate reason to be bigger
		if err != nil {
			http.Error(w, "read error", http.StatusBadRequest)
			return
		}

		sig := r.Header.Get("X-Signature")
		if sig == "" || !ipc.Verify(secretBytes, body, sig) {
			// Deliberately generic response — don't help an attacker distinguish
			// "bad signature" from "malformed body" from anything else.
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		var req ipc.ExecuteRequest
		if err := json.Unmarshal(body, &req); err != nil {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}

		result := executor.Execute(executor.Request{
			ToolCallID: req.ToolCallID,
			Tool:       req.Tool,
			Params:     req.Params,
		})

		resp := ipc.ExecuteResponse{
			ToolCallID: result.ToolCallID,
			Success:    result.Success,
			Data:       result.Data,
			Error:      result.Error,
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})

	// Loopback-only address is the primary control here — 127.0.0.1 doesn't
	// accept connections from other hosts regardless of firewall state.
	srv := &http.Server{Addr: addr, Handler: mux}
	serveErr := make(chan error, 1)
	go func() {
		log.Printf("executor listening on %s (loopback only)", addr)
		serveErr <- srv.ListenAndServe()
	}()

	select {
	case err := <-serveErr:
		if err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	case <-stopCh:
		log.Print("executor stopping")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			log.Printf("graceful shutdown failed: %v", err)
		}
	}
}
