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
	"time"

	"support-agent/agent/internal/ipc"
	"support-agent/agent/internal/transport"
)

func main() {
	backendURL := requireEnv("AGENT_BACKEND_URL")
	deviceID := requireEnv("AGENT_DEVICE_ID")
	secret := requireEnv("AGENT_IPC_SECRET")

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

	client := transport.NewClient(backendURL, deviceID)
	httpClient := &http.Client{Timeout: 30 * time.Second} // generous — some tools (service restart) legitimately take a while

	log.Printf("daemon polling %s every %s for device %s", backendURL, pollInterval, deviceID)

	for {
		calls, err := client.PollPending()
		if err != nil {
			log.Printf("poll error: %v", err)
			time.Sleep(pollInterval)
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

		time.Sleep(pollInterval)
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

	resp, err := httpClient.Do(httpReq)
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
