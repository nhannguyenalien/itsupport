//go:build windows

package tools

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// windows_update.clear_cache — clears the Windows Update download cache
// (SoftwareDistribution\Download), the standard first fix for updates stuck
// downloading or failing with a corrupt payload, and a common source of
// reclaimable space. Fixed path, no parameters. Windows re-downloads what it
// still needs. Write action (risk "medium"), verified by disk.usage.

var updateServices = []string{"wuauserv", "bits"}

func updateDownloadDir() string {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	return filepath.Join(root, "SoftwareDistribution", "Download")
}

func WindowsUpdateClearCache(params map[string]any) (map[string]any, error) {
	m, err := mgr.Connect()
	if err != nil {
		return nil, fmt.Errorf("connect to service manager: %w", err)
	}
	defer m.Disconnect()

	wasRunning := map[string]bool{}
	var restartDependents []string
	stopErr := error(nil)
	for _, name := range updateServices {
		state, err := serviceState(m, name)
		if err != nil {
			stopErr = err
			break
		}
		wasRunning[name] = state == svc.Running || state == svc.StartPending
		deps, err := stopServiceWithDependents(m, name)
		restartDependents = append(restartDependents, deps...)
		if err != nil {
			stopErr = err
			break
		}
	}
	restore := func() []string {
		var failed []string
		for _, name := range append(append([]string{}, updateServices...), restartDependents...) {
			if wasRunning[name] || contains(restartDependents, name) {
				if startServiceAndWait(m, name) != nil {
					failed = append(failed, name)
				}
			}
		}
		return failed
	}
	if stopErr != nil {
		restore()
		return nil, stopErr
	}

	dir := updateDownloadDir()
	var freed int64
	var removed, failed int
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		path := filepath.Join(dir, e.Name())
		bytes, _, _ := measureDir(path, &spaceBudget{deadline: time.Now().Add(5 * time.Minute)})
		if e.Type().IsRegular() {
			if info, err := e.Info(); err == nil {
				bytes = info.Size()
			}
		}
		if err := os.RemoveAll(path); err != nil {
			failed++
			continue
		}
		removed++
		freed += bytes
	}

	notRestarted := restore()
	result := map[string]any{
		"path":          dir,
		"items_removed": removed,
		"items_failed":  failed,
		"freed_mb":      round1(float64(freed) / (1 << 20)),
	}
	if len(notRestarted) > 0 {
		result["services_not_restarted"] = notRestarted
	}
	return result, nil
}

func contains(list []string, value string) bool {
	for _, v := range list {
		if v == value {
			return true
		}
	}
	return false
}
