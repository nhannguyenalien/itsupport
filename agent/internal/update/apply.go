//go:build windows || darwin || linux

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
	"runtime"
	"strings"
	"time"

	"support-agent/agent/internal/config"
	"support-agent/agent/internal/version"
)

// Apply runs inside the executor when a user clicks "Cập nhật" for this
// device. It downloads the signed release for this platform from the same
// origin the agent was enrolled against, verifies the signature and every
// hash, checks each staged binary starts and reports the requested version,
// then swaps the files in place (keeping *.old copies) and schedules the
// service restarts (restart_<os>.go). If the new daemon/telemetry services do
// not come back, the previous binaries are restored.

func platformKey() string { return runtime.GOOS + "-" + runtime.GOARCH }

func releaseFiles() []string {
	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	return []string{"daemon" + ext, "enroll" + ext, "executor" + ext, "telemetry" + ext}
}

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
	return u.Scheme + "://" + u.Host + "/downloads/agent/" + platformKey() + "/", nil
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
	m, err := VerifyManifest(manifestBytes, string(signature), ReleasePublicKey, platformKey(), want, releaseFiles())
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
		if err := os.WriteFile(path, data, 0o700); err != nil {
			os.RemoveAll(stage)
			return nil, fmt.Errorf("stage %s: %w", f.Name, err)
		}
		if got, err := stagedVersion(path); err != nil || got != want {
			os.RemoveAll(stage)
			return nil, fmt.Errorf("staged %s did not start correctly (reported %q)", f.Name, got)
		}
	}

	// Windows allows renaming a running executable and Unix keeps the running
	// inode, so swap every file and keep the previous one as *.old.
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

func restartOntoNewVersion(dir string, swapped []string, to string) {
	time.Sleep(restartDelay)
	if err := restartPeers(); err != nil {
		log.Printf("update %s: new daemon/telemetry did not start (%v); restoring previous binaries", to, err)
		restore(dir, swapped)
		if err := restartPeers(); err != nil {
			log.Printf("update %s: restarting previous binaries also failed: %v", to, err)
		}
		return
	}
	// The executor cannot restart itself through its own service manager while
	// handling this call. Exiting lets the service manager (SCM recovery,
	// launchd KeepAlive, systemd Restart=always) start the new binary.
	log.Printf("update %s: daemon and telemetry running; restarting executor", to)
	os.Exit(3)
}
