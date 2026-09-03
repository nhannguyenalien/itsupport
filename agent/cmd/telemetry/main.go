// Telemetry. Low privilege, same tier as the daemon (docs/v0.1-spec.md process
// separation). Its only job in v0.1 is a periodic heartbeat so the backend
// can flip a device to online/offline — richer telemetry (resource trends,
// proactive alerts) is explicitly out of scope for v0.1 (see docs/v0.1-spec.md
// IN/OUT contract; this process exists so that scope has somewhere to land
// later without re-architecting privilege separation).
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"support-agent/agent/internal/config"
	"support-agent/agent/internal/winsvc"
)

func main() {
	if err := winsvc.RunAsService("SupportAgentTelemetry", run); err != nil {
		log.Fatal(err)
	}
}

// run is the actual heartbeat loop, extracted out of main() so it can be
// driven either by the Windows Service Control Manager (winsvc.RunAsService)
// or directly when running interactively for dev/testing.
func run(stopCh <-chan struct{}) {
	cfg := config.LoadWithEnvOverride(config.DefaultPath())
	if cfg.BackendURL == "" || cfg.DeviceID == "" {
		log.Fatal("no backend URL / device ID — run cmd/enroll first, or set AGENT_BACKEND_URL / AGENT_DEVICE_ID")
	}
	backendURL := cfg.BackendURL
	deviceID := cfg.DeviceID

	interval := 30 * time.Second
	if v := os.Getenv("AGENT_HEARTBEAT_INTERVAL_SECONDS"); v != "" {
		if d, err := time.ParseDuration(v + "s"); err == nil {
			interval = d
		}
	}

	client := &http.Client{Timeout: 10 * time.Second}
	url := fmt.Sprintf("%s/devices/%s/heartbeat", backendURL, deviceID)

	log.Printf("telemetry heartbeating %s every %s", url, interval)

	heartbeat := func() {
		resp, err := client.Post(url, "application/json", nil)
		if err != nil {
			log.Printf("heartbeat failed: %v", err)
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			log.Printf("heartbeat rejected: status %d", resp.StatusCode)
		}
	}

	heartbeat() // same behavior as before — first beat happens immediately, not after the first interval
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-stopCh:
			log.Print("telemetry stopping")
			return
		case <-ticker.C:
			heartbeat()
		}
	}
}
