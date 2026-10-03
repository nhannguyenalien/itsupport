//go:build windows

package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"support-agent/agent/internal/config"
	"support-agent/agent/internal/version"
)

// Apply runs inside the executor service (LocalSystem) when a user clicks
// "Cập nhật" for this device. It downloads the signed release for this
// platform from the same origin the agent was enrolled against, verifies the
// signature and every hash, checks each staged binary starts and reports the
// requested version, then swaps the files in place (keeping *.old copies) and
// schedules the service restarts. If the new daemon/telemetry services do not
// reach RUNNING, the previous binaries are restored.

const platform = "windows-amd64"

var releaseFiles = []string{"daemon.exe", "enroll.exe", "executor.exe", "telemetry.exe"}

// Service names as registered by install/install.ps1.
var restartOrder = []string{"SupportAgentTelemetry", "SupportAgentDaemon"}

const executorService = "SupportAgentExecutor"

// restartDelay leaves the daemon time to report this call's result before it
// is restarted onto the new binary.
const restartDelay = 15 * time.Second

var httpClient = &http.Client{Timeout: 2 * time.Minute}

func installDir() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Dir(exe), nil
}

func downloadBase() (string, error) {
	cfg, err := config.Load(config.DefaultPath())
	if err != nil {
		return "", fmt.Errorf("read agent config: %w", err)
	}
	u, err := url.Parse(cfg.BackendURL)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("agent backend URL is invalid")
	}
	if u.Scheme != "https" && u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" {
		return "", fmt.Errorf("updates require an https backend")
	}
	return u.Scheme + "://" + u.Host + "/downloads/agent/" + platform + "/", nil
}

func fetch(u string, limit int64) ([]byte, error) {
	resp, err := httpClient.Get(u)
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", u, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download %s: status %d", u, resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", u, err)
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("download %s: larger than expected", u)
	}
	return data, nil
}

func stagedVersion(path string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "-version").Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func Apply(params map[string]any) (map[string]any, error) {
	want, _ := params["version"].(string)
	if !ValidVersion(want) {
		return nil, fmt.Errorf("version must look like 1.2.3")
	}
	if want == version.Version {
		return map[string]any{"from": version.Version, "to": want, "already_current": true}, nil
	}
	if !Newer(want, version.Version) {
		return nil, fmt.Errorf("refusing to downgrade from %s to %s", version.Version, want)
	}
	base, err := downloadBase()
	if err != nil {
		return nil, err
	}
	manifestBytes, err := fetch(base+"manifest.json", 64<<10)
	if err != nil {
		return nil, err
	}
	signature, err := fetch(base+"manifest.sig", 4<<10)
	if err != nil {
		return nil, err
	}
	m, err := VerifyManifest(manifestBytes, string(signature), ReleasePublicKey, platform, want, releaseFiles)
	if err != nil {
		return nil, err
	}

	dir, err := installDir()
	if err != nil {
		return nil, err
	}
	stage := filepath.Join(dir, "update-staging")
	os.RemoveAll(stage)
	if err := os.MkdirAll(stage, 0o755); err != nil {
		return nil, fmt.Errorf("create staging directory: %w", err)
	}
	for _, f := range m.Files {
		data, err := fetch(base+f.Name, MaxBinarySize)
		if err != nil {
			os.RemoveAll(stage)
			return nil, err
		}
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) != f.SHA256 || int64(len(data)) != f.Size {
			os.RemoveAll(stage)
			return nil, fmt.Errorf("%s does not match the signed manifest", f.Name)
		}
		path := filepath.Join(stage, f.Name)
		if err := os.WriteFile(path, data, 0o755); err != nil {
			os.RemoveAll(stage)
			return nil, fmt.Errorf("stage %s: %w", f.Name, err)
		}
		if got, err := stagedVersion(path); err != nil || got != want {
			os.RemoveAll(stage)
			return nil, fmt.Errorf("staged %s did not start correctly (reported %q)", f.Name, got)
		}
	}

	// Windows allows renaming a running executable, so swap every file and
	// keep the previous one as *.old for rollback.
	swapped := make([]string, 0, len(m.Files))
	for _, f := range m.Files {
		current := filepath.Join(dir, f.Name)
		old := current + ".old"
		os.Remove(old)
		if err := os.Rename(current, old); err != nil && !os.IsNotExist(err) {
			restore(dir, swapped)
			return nil, fmt.Errorf("move current %s aside: %w", f.Name, err)
		}
		if err := os.Rename(filepath.Join(stage, f.Name), current); err != nil {
			os.Rename(old, current)
			restore(dir, swapped)
			return nil, fmt.Errorf("install %s: %w", f.Name, err)
		}
		swapped = append(swapped, f.Name)
	}
	os.RemoveAll(stage)

	go restartOntoNewVersion(dir, swapped, want)
	return map[string]any{"from": version.Version, "to": want, "restarting_in_seconds": int(restartDelay.Seconds())}, nil
}

func restore(dir string, names []string) {
	for _, name := range names {
		current := filepath.Join(dir, name)
		os.Remove(current)
		os.Rename(current+".old", current)
	}
}

func restartService(m *mgr.Mgr, name string) error {
	s, err := m.OpenService(name)
	if err != nil {
		return err
	}
	defer s.Close()
	if status, err := s.Query(); err == nil && status.State != svc.Stopped {
		s.Control(svc.Stop)
		waitFor(s, svc.Stopped, 30*time.Second)
	}
	if err := s.Start(); err != nil {
		return err
	}
	return waitFor(s, svc.Running, 30*time.Second)
}

func waitFor(s *mgr.Service, want svc.State, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if status, err := s.Query(); err == nil && status.State == want {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("service did not reach the expected state")
}

func restartOntoNewVersion(dir string, swapped []string, to string) {
	time.Sleep(restartDelay)
	m, err := mgr.Connect()
	if err != nil {
		log.Printf("update %s: connect to service manager: %v", to, err)
		return
	}
	defer m.Disconnect()
	for _, name := range restartOrder {
		if err := restartService(m, name); err != nil {
			log.Printf("update %s: %s failed on the new version (%v); restoring previous binaries", to, name, err)
			restore(dir, swapped)
			for _, n := range restartOrder {
				restartService(m, n)
			}
			return
		}
	}
	// The executor cannot restart itself through the SCM while running. Exit
	// so the service recovery action configured by install.ps1 starts the new
	// executor binary.
	log.Printf("update %s: daemon and telemetry running; restarting %s", to, executorService)
	os.Exit(3)
}
