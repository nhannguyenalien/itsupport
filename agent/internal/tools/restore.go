package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
)

// backup.snapshots / backup.restore — getting data back out of a restic repo.
//
// A restore NEVER writes over live files: it extracts into a separate, empty
// target directory chosen by the operator, and the person at the machine (or a
// technician) copies back what they need. That removes the failure mode where a
// misclicked restore destroys newer data. backup.restore is risk "high" and is
// only ever created by an admin clicking Restore in the dashboard.

const (
	maxSnapshotsListed = 50
	maxRestoreIncludes = 20
	restoreTimeout     = 8 * time.Hour
)

var snapshotIDPattern = regexp.MustCompile(`^([0-9a-f]{8,64}|latest)$`)

type restoreState struct {
	State         string `json:"state"` // idle | running | success | error
	SnapshotID    string `json:"snapshot_id,omitempty"`
	Target        string `json:"target,omitempty"`
	StartedAt     string `json:"started_at,omitempty"`
	FinishedAt    string `json:"finished_at,omitempty"`
	FilesRestored int64  `json:"files_restored,omitempty"`
	BytesRestored int64  `json:"bytes_restored,omitempty"`
	Error         string `json:"error,omitempty"`
}

func restoreStatePath() string { return filepath.Join(backupDir(), "restore-state.json") }

func readRestoreState() restoreState {
	data, err := os.ReadFile(restoreStatePath())
	if err != nil {
		return restoreState{State: "idle"}
	}
	var s restoreState
	if json.Unmarshal(data, &s) != nil || s.State == "" {
		return restoreState{State: "idle"}
	}
	if s.State == "running" {
		if started, err := time.Parse(time.RFC3339, s.StartedAt); err == nil && time.Since(started) > restoreTimeout {
			s.State, s.Error = "error", "restore interrupted (agent restarted)"
		}
	}
	return s
}

func writeRestoreState(s restoreState) {
	data, _ := json.Marshal(s)
	_ = os.MkdirAll(filepath.Dir(restoreStatePath()), 0o700)
	_ = os.WriteFile(restoreStatePath(), data, 0o600)
}

// protectedRestoreRoots are locations a restore target may never be inside.
func protectedRestoreRoots() []string {
	roots := []string{backupDir()}
	for _, key := range []string{"SystemRoot", "ProgramFiles", "ProgramFiles(x86)"} {
		if v := os.Getenv(key); v != "" {
			roots = append(roots, v)
		}
	}
	if runtime.GOOS != "windows" {
		roots = append(roots, "/etc", "/usr", "/bin", "/sbin", "/boot", "/System", "/Library", "/var/lib", "/data/coolify")
	}
	return roots
}

func within(path, root string) bool {
	p, r := strings.ToLower(filepath.Clean(path)), strings.ToLower(filepath.Clean(root))
	return p == r || strings.HasPrefix(p, r+string(filepath.Separator))
}

// validateRestoreTarget accepts only a new or empty directory that is not a
// filesystem root and not inside the OS, program, or agent directories.
func validateRestoreTarget(target string) (string, error) {
	if target == "" || strings.ContainsRune(target, 0) || !filepath.IsAbs(target) {
		return "", fmt.Errorf("target must be an absolute directory path")
	}
	t := filepath.Clean(target)
	if filepath.Dir(t) == t || (runtime.GOOS == "windows" && len(filepath.VolumeName(t)) > 0 && t == filepath.VolumeName(t)+`\`) {
		return "", fmt.Errorf("target must not be a drive or filesystem root")
	}
	for _, root := range protectedRestoreRoots() {
		if within(t, root) {
			return "", fmt.Errorf("target must not be inside %s", root)
		}
	}
	entries, err := os.ReadDir(t)
	switch {
	case err == nil && len(entries) > 0:
		return "", fmt.Errorf("target directory must be empty — restore never overwrites existing files")
	case err != nil && !os.IsNotExist(err):
		return "", fmt.Errorf("cannot use target: %v", err)
	}
	return t, nil
}

// BackupSnapshots lists recent snapshots (read-only, synchronous).
func BackupSnapshots(params map[string]any) (map[string]any, error) {
	r, err := parseAccess(params)
	if err != nil {
		return nil, err
	}
	if err := ensureRestic(r); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	var stdout, stderr bytes.Buffer
	cmd := r.restic(ctx, "snapshots", "--json", "--no-lock", "--tag", "support-agent")
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("list snapshots: %v: %s", err, scrub(stderr.String(), r.secrets))
	}
	var raw []struct {
		ShortID  string   `json:"short_id"`
		Time     string   `json:"time"`
		Hostname string   `json:"hostname"`
		Paths    []string `json:"paths"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &raw); err != nil {
		return nil, fmt.Errorf("unexpected restic output")
	}
	sort.Slice(raw, func(i, j int) bool { return raw[i].Time > raw[j].Time })
	if len(raw) > maxSnapshotsListed {
		raw = raw[:maxSnapshotsListed]
	}
	list := make([]map[string]any, 0, len(raw))
	for _, s := range raw {
		list = append(list, map[string]any{"id": s.ShortID, "time": s.Time, "hostname": s.Hostname, "paths": s.Paths})
	}
	return map[string]any{"snapshots": list}, nil
}

// BackupRestore validates the request and extracts the snapshot in the background.
func BackupRestore(params map[string]any) (map[string]any, error) {
	r, err := parseAccess(params)
	if err != nil {
		return nil, err
	}
	snap, err := requireStringParam(params, "snapshot_id")
	if err != nil || !snapshotIDPattern.MatchString(snap) {
		return nil, fmt.Errorf("snapshot_id must be a snapshot id or \"latest\"")
	}
	rawTarget, err := requireStringParam(params, "target")
	if err != nil {
		return nil, err
	}
	target, err := validateRestoreTarget(rawTarget)
	if err != nil {
		return nil, err
	}
	var includes []string
	if raw, ok := params["include"]; ok {
		list, err := stringSlice(raw)
		if err != nil || len(list) > maxRestoreIncludes {
			return nil, fmt.Errorf("\"include\" must be up to %d paths", maxRestoreIncludes)
		}
		for _, p := range list {
			if !filepath.IsAbs(p) || strings.HasPrefix(p, "-") || strings.ContainsRune(p, 0) {
				return nil, fmt.Errorf("include path %q must be absolute", p)
			}
			includes = append(includes, p)
		}
	}

	backupMu.Lock()
	if cur := readBackupState(); cur.State == "running" {
		backupMu.Unlock()
		return nil, fmt.Errorf("a backup is running; restore after it finishes")
	}
	if cur := readRestoreState(); cur.State == "running" {
		backupMu.Unlock()
		return nil, fmt.Errorf("a restore is already running")
	}
	state := restoreState{State: "running", SnapshotID: snap, Target: target, StartedAt: time.Now().UTC().Format(time.RFC3339)}
	writeRestoreState(state)
	backupMu.Unlock()

	go runRestoreJob(r, state, includes)
	return map[string]any{"started": true, "target": target, "snapshot_id": snap}, nil
}

func runRestoreJob(r backupRequest, state restoreState, includes []string) {
	finish := func(err error, output string) {
		state.FinishedAt = time.Now().UTC().Format(time.RFC3339)
		if err != nil {
			state.State, state.Error = "error", scrub(fmt.Sprintf("%v: %s", err, output), r.secrets)
		} else {
			state.State = "success"
		}
		backupMu.Lock()
		writeRestoreState(state)
		backupMu.Unlock()
	}
	if err := ensureRestic(r); err != nil {
		finish(err, "")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), restoreTimeout)
	defer cancel()
	if err := os.MkdirAll(state.Target, 0o700); err != nil {
		finish(err, "")
		return
	}
	args := []string{"restore", state.SnapshotID, "--json", "--target", state.Target}
	for _, p := range includes {
		args = append(args, "--include", p)
	}
	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, resticPath(), append([]string{"-r", r.repo}, args...)...)
	cmd.Env = append(append(os.Environ(), r.env...), "RESTIC_CACHE_DIR="+filepath.Join(backupDir(), "restic-cache"))
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	for _, line := range bytes.Split(stdout.Bytes(), []byte("\n")) {
		var msg struct {
			MessageType   string `json:"message_type"`
			FilesRestored int64  `json:"files_restored"`
			BytesRestored int64  `json:"bytes_restored"`
		}
		if json.Unmarshal(line, &msg) == nil && msg.MessageType == "summary" {
			state.FilesRestored, state.BytesRestored = msg.FilesRestored, msg.BytesRestored
		}
	}
	finish(err, stderr.String())
}
