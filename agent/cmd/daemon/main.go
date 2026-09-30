// The connection daemon. Low privilege by design (docs/v0.1-spec.md process
// separation) — it never touches a Windows API that changes system state
// itself. Its only jobs: poll the backend for work, hand each call to the
// separate elevated executor process over the signed local IPC channel, and
// report the result back. If this process is compromised, the attacker still
// has to get past the executor's own signature+allowlist checks to do anything.
package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"support-agent/agent/internal/config"
	"support-agent/agent/internal/ipc"
	"support-agent/agent/internal/transport"
	"support-agent/agent/internal/winsvc"
)

func main() {
	configureFileLogging("daemon.log")
	if err := winsvc.RunAsService("SupportAgentDaemon", run); err != nil {
		log.Fatal(err)
	}
}

func configureFileLogging(name string) {
	dir := filepath.Dir(config.DefaultPath())
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return
	}
	f, err := os.OpenFile(filepath.Join(dir, name), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err == nil {
		log.SetOutput(f)
	}
}

// run is the actual poll loop, extracted out of main() so it can be driven
// either by the Windows Service Control Manager (winsvc.RunAsService) or
// directly when running interactively for dev/testing.
func run(stopCh <-chan struct{}) {
	// Config file (written by cmd/enroll) is the primary source; env vars
	// override individual fields on top of it — see internal/config.
	cfg := config.LoadWithEnvOverride(config.DefaultPath())
	if cfg.BackendURL == "" {
		log.Fatal("no backend URL — run cmd/enroll first, or set AGENT_BACKEND_URL")
	}
	if cfg.DeviceID == "" {
		log.Fatal("no device ID — run cmd/enroll first, or set AGENT_DEVICE_ID")
	}
	backendURL := cfg.BackendURL
	deviceID := cfg.DeviceID
	secret := requireEnv("AGENT_IPC_SECRET") // never persisted to the config file — shared secret only, not device identity

	executorAddr := ipc.DefaultAddr
	if v := os.Getenv("AGENT_IPC_ADDR"); v != "" {
		executorAddr = v
	}

	pollInterval := 5 * time.Second
	if v := os.Getenv("AGENT_POLL_INTERVAL_SECONDS"); v != "" {
		if d, err := time.ParseDuration(v + "s"); err == nil {
			pollInterval = d
		}
	}

	client, err := transport.NewClient(backendURL, deviceID, cfg.AgentToken, cfg.CertificatePEM, cfg.PrivateKeyPEM, cfg.CACertificatePEM)
	if err != nil {
		log.Fatalf("configure agent transport: %v", err)
	}
	httpClient := &http.Client{Timeout: 30 * time.Second} // generous — some tools (service restart) legitimately take a while

	log.Printf("daemon polling %s every %s for device %s", backendURL, pollInterval, deviceID)

	// sleep is time.Sleep but interruptible by stopCh, so a Stop/Shutdown
	// request from the SCM doesn't have to wait out a full poll interval —
	// same reasoning as telemetry's ticker-based loop, just written as a
	// helper since this loop's two sleep points (error backoff, normal poll)
	// share the same needs.
	sleep := func(d time.Duration) (stopped bool) {
		select {
		case <-stopCh:
			return true
		case <-time.After(d):
			return false
		}
	}

	for {
		calls, err := client.PollPending()
		if err != nil {
			log.Printf("poll error: %v", err)
			if sleep(pollInterval) {
				log.Print("daemon stopping")
				return
			}
			continue
		}

		for _, call := range calls {
			result := callExecutor(httpClient, executorAddr, secret, call)

			payload := transport.ResultPayload{}
			if result.Success {
				payload.Result = "success"
				payload.ResultData = result.Data
			} else {
				payload.Result = "error"
				payload.ErrorMessage = result.Error
			}
			if err := client.ReportResult(call.ID, payload); err != nil {
				log.Printf("failed to report result for %s: %v", call.ID, err)
			}
		}

		if sleep(pollInterval) {
			log.Print("daemon stopping")
			return
		}
	}
}

func callExecutor(httpClient *http.Client, addr, secret string, call transport.PendingCall) ipc.ExecuteResponse {
	req := ipc.ExecuteRequest{ToolCallID: call.ID, Tool: call.Tool, Params: call.Params}
	body, err := ipc.MarshalRequest(req)
	if err != nil {
		return ipc.ExecuteResponse{ToolCallID: call.ID, Success: false, Error: err.Error()}
	}

	httpReq, err := http.NewRequest(http.MethodPost, "http://"+addr+"/execute", bytes.NewReader(body))
	if err != nil {
		return ipc.ExecuteResponse{ToolCallID: call.ID, Success: false, Error: err.Error()}
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-Signature", ipc.Sign([]byte(secret), body))

	client := *httpClient
	if call.Tool == "package.install" {
		client.Timeout = 12 * time.Minute
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		return ipc.ExecuteResponse{ToolCallID: call.ID, Success: false, Error: "executor unreachable: " + err.Error()}
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	var result ipc.ExecuteResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return ipc.ExecuteResponse{ToolCallID: call.ID, Success: false, Error: "malformed executor response"}
	}
	return result
}

func requireEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("%s is not set", key)
	}
	return v
}
