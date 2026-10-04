package tools

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// backup.run / backup.status — proactive file backup through restic.
//
// restic is a separate, unmodified binary: it is the one that encrypts, dedups
// and talks to the repository, so this file only (1) validates what the backend
// asked for, (2) runs a FIXED restic command line (never a shell, never caller
// supplied flags), and (3) records progress in a state file. backup.run returns
// as soon as the job is started — a backup can take hours and the daemon polls
// tool calls sequentially, so blocking it would freeze support actions. The
// outcome is read back with backup.status.
//
// Secrets (repository password, S3/B2 keys) arrive in params only for the
// lifetime of the call: they are injected into the restic process environment,
// never written to disk or the state file, and scrubbed from any error text.

const (
	maxBackupPaths    = 20
	maxBackupExcludes = 50
	backupTimeout     = 8 * time.Hour
)

// Only these variables may be set on the restic process — no PATH, no
// RESTIC_PASSWORD_COMMAND, nothing that could make restic run another program.
var backupEnvAllowlist = map[string]bool{
	"RESTIC_PASSWORD":       true,
	"AWS_ACCESS_KEY_ID":     true,
	"AWS_SECRET_ACCESS_KEY": true,
	"AWS_DEFAULT_REGION":    true,
	"B2_ACCOUNT_ID":         true,
	"B2_ACCOUNT_KEY":        true,
	"RESTIC_REST_USERNAME":  true,
	"RESTIC_REST_PASSWORD":  true,
}

type backupState struct {
	State        string  `json:"state"` // idle | running | success | error
	StartedAt    string  `json:"started_at,omitempty"`
	FinishedAt   string  `json:"finished_at,omitempty"`
	Step         string  `json:"step,omitempty"`
	SnapshotID   string  `json:"snapshot_id,omitempty"`
	FilesNew     int64   `json:"files_new,omitempty"`
	FilesChanged int64   `json:"files_changed,omitempty"`
	BytesAdded   int64   `json:"bytes_added,omitempty"`
	BytesTotal   int64   `json:"bytes_total,omitempty"`
	DurationSec  float64 `json:"duration_sec,omitempty"`
	Error        string  `json:"error,omitempty"`
}

var backupMu sync.Mutex // guards the state file and the single running job

func backupDir() string {
	if runtime.GOOS == "windows" {
		programData := os.Getenv("ProgramData")
		if programData == "" {
			programData = `C:\ProgramData`
		}
		return filepath.Join(programData, "support-agent")
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = "."
	}
	return filepath.Join(dir, "support-agent")
}

func resticPath() string {
	name := "restic"
	if runtime.GOOS == "windows" {
		name = "restic.exe"
	}
	return filepath.Join(backupDir(), "bin", name)
}

func backupStatePath() string { return filepath.Join(backupDir(), "backup-state.json") }

func readBackupState() backupState {
	data, err := os.ReadFile(backupStatePath())
	if err != nil {
		return backupState{State: "idle"}
	}
	var s backupState
	if json.Unmarshal(data, &s) != nil || s.State == "" {
		return backupState{State: "idle"}
	}
	return s
}

func writeBackupState(s backupState) {
	data, _ := json.Marshal(s)
	_ = os.MkdirAll(filepath.Dir(backupStatePath()), 0o700)
	_ = os.WriteFile(backupStatePath(), data, 0o600)
}

func resticVersion() string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, resticPath(), "version").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// BackupStatus reports whether restic is installed and the outcome of the most
// recent backup.run. A "running" state older than backupTimeout means the
// executor was restarted mid-backup (the restic child dies with it).
func BackupStatus(params map[string]any) (map[string]any, error) {
	backupMu.Lock()
	state := readBackupState()
	if state.State == "running" {
		if started, err := time.Parse(time.RFC3339, state.StartedAt); err == nil && time.Since(started) > backupTimeout {
			state.State, state.Error = "error", "backup interrupted (agent restarted)"
			writeBackupState(state)
		}
	}
	backupMu.Unlock()
	restore := readRestoreState()
	version := resticVersion()
	out := map[string]any{
		"restore_state":    restore.State,
		"restic_installed": version != "",
		"restic_version":   version,
		"state":            state.State,
	}
	for k, v := range map[string]any{
		"started_at": state.StartedAt, "finished_at": state.FinishedAt, "step": state.Step,
		"snapshot_id": state.SnapshotID, "error": state.Error,
	} {
		if v != "" {
			out[k] = v
		}
	}
	if restore.State != "idle" {
		out["restore"] = restore
	}
	if state.State == "success" {
		out["files_new"], out["files_changed"] = state.FilesNew, state.FilesChanged
		out["bytes_added"], out["bytes_total"], out["duration_sec"] = state.BytesAdded, state.BytesTotal, state.DurationSec
	}
	return out, nil
}

type backupRequest struct {
	repo       string
	env        []string
	secrets    []string
	paths      []string
	excludes   []string
	keepDaily  int
	keepWeekly int
	keepMonth  int
	useVSS     bool
	limitKbps  int
	resticURL  string
	resticSHA  string
}

func intParam(params map[string]any, key string, def, min, max int) (int, error) {
	v, ok := params[key]
	if !ok {
		return def, nil
	}
	f, ok := v.(float64)
	if !ok || f != float64(int(f)) || int(f) < min || int(f) > max {
		return 0, fmt.Errorf("param %q must be an integer between %d and %d", key, min, max)
	}
	return int(f), nil
}

// parseAccess validates what every restic operation needs: the repository and
// the (allowlisted) credentials, plus the optional restic download pin.
func parseAccess(params map[string]any) (backupRequest, error) {
	var r backupRequest
	repo, err := requireStringParam(params, "repo")
	if err != nil {
		return r, err
	}
	// restic repository syntaxes we support: rest:https://…, s3:https://…/bucket,
	// b2:bucket:path, sftp is deliberately excluded (it would shell out to ssh).
	if !(strings.HasPrefix(repo, "rest:https://") || strings.HasPrefix(repo, "rest:http://") ||
		strings.HasPrefix(repo, "s3:https://") || strings.HasPrefix(repo, "b2:")) {
		return r, fmt.Errorf("unsupported repository scheme (use rest:, s3: or b2:)")
	}
	r.repo = repo

	rawEnv, ok := params["env"].(map[string]any)
	if !ok {
		return r, fmt.Errorf("param \"env\" must be an object")
	}
	if s, _ := rawEnv["RESTIC_PASSWORD"].(string); s == "" {
		return r, fmt.Errorf("RESTIC_PASSWORD is required")
	}
	for k, v := range rawEnv {
		s, ok := v.(string)
		if !ok || !backupEnvAllowlist[k] {
			return r, fmt.Errorf("env variable %q is not allowed", k)
		}
		if s == "" {
			continue
		}
		r.env = append(r.env, k+"="+s)
		r.secrets = append(r.secrets, s)
	}

	r.resticURL, _ = params["restic_url"].(string)
	r.resticSHA, _ = params["restic_sha256"].(string)
	return r, nil
}

func parseBackupRequest(params map[string]any) (backupRequest, error) {
	r, err := parseAccess(params)
	if err != nil {
		return r, err
	}
	paths, err := stringSlice(params["paths"])
	if err != nil || len(paths) == 0 || len(paths) > maxBackupPaths {
		return r, fmt.Errorf("param \"paths\" must be 1-%d absolute paths", maxBackupPaths)
	}
	for _, p := range paths {
		if !filepath.IsAbs(p) || strings.ContainsRune(p, 0) || strings.HasPrefix(p, "-") {
			return r, fmt.Errorf("path %q must be absolute", p)
		}
		r.paths = append(r.paths, filepath.Clean(p))
	}
	if raw, ok := params["excludes"]; ok {
		ex, err := stringSlice(raw)
		if err != nil || len(ex) > maxBackupExcludes {
			return r, fmt.Errorf("param \"excludes\" must be up to %d patterns", maxBackupExcludes)
		}
		for _, e := range ex {
			if e == "" || strings.HasPrefix(e, "-") || strings.ContainsRune(e, 0) {
				return r, fmt.Errorf("invalid exclude pattern %q", e)
			}
			r.excludes = append(r.excludes, e)
		}
	}

	if r.keepDaily, err = intParam(params, "keep_daily", 7, 0, 365); err != nil {
		return r, err
	}
	if r.keepWeekly, err = intParam(params, "keep_weekly", 4, 0, 104); err != nil {
		return r, err
	}
	if r.keepMonth, err = intParam(params, "keep_monthly", 6, 0, 120); err != nil {
		return r, err
	}
	if r.keepDaily+r.keepWeekly+r.keepMonth == 0 {
		return r, fmt.Errorf("retention must keep at least one snapshot")
	}
	if r.limitKbps, err = intParam(params, "limit_upload_kbps", 0, 0, 10_000_000); err != nil {
		return r, err
	}
	r.useVSS, _ = params["use_vss"].(bool)
	return r, nil
}

// ensureRestic downloads a restic executable (operator-hosted raw binary) only
// when none is installed, and only over https with a pinned SHA-256.
func ensureRestic(r backupRequest) error {
	if resticVersion() != "" {
		return nil
	}
	if r.resticURL == "" || len(r.resticSHA) != 64 {
		return fmt.Errorf("restic is not installed and no restic_url/restic_sha256 was provided")
	}
	u, err := url.Parse(r.resticURL)
	if err != nil || u.Scheme != "https" {
		return fmt.Errorf("restic_url must be https")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, r.resticURL, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("download restic: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download restic: HTTP %d", resp.StatusCode)
	}
	dest := resticPath()
	if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
		return err
	}
	tmp := dest + ".download"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o700)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, copyErr := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, 200<<20))
	closeErr := f.Close()
	if copyErr != nil || closeErr != nil {
		os.Remove(tmp)
		return fmt.Errorf("download restic: incomplete")
	}
	if !strings.EqualFold(hex.EncodeToString(h.Sum(nil)), r.resticSHA) {
		os.Remove(tmp)
		return fmt.Errorf("restic checksum mismatch — refusing to install")
	}
	if err := os.Rename(tmp, dest); err != nil {
		return err
	}
	if resticVersion() == "" {
		os.Remove(dest)
		return fmt.Errorf("downloaded restic does not run")
	}
	return nil
}

func scrub(text string, secrets []string) string {
	for _, s := range secrets {
		if len(s) >= 4 {
			text = strings.ReplaceAll(text, s, "***")
		}
	}
	if len(text) > 1500 {
		text = text[len(text)-1500:]
	}
	return strings.TrimSpace(text)
}

func (r backupRequest) restic(ctx context.Context, args ...string) *exec.Cmd {
	// Fixed executable, fixed subcommands; user data only ever appears as a
	// separate argv element after "--" or as the value of a known flag.
	cmd := exec.CommandContext(ctx, resticPath(), append([]string{"-r", r.repo}, args...)...)
	cmd.Env = append(os.Environ(), r.env...)
	cmd.Env = append(cmd.Env, "RESTIC_CACHE_DIR="+filepath.Join(backupDir(), "restic-cache"))
	return cmd
}

func (r backupRequest) runPlain(ctx context.Context, args ...string) (string, error) {
	var out bytes.Buffer
	cmd := r.restic(ctx, args...)
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	return out.String(), err
}

func runBackupJob(r backupRequest, state backupState) {
	started := time.Now()
	fail := func(step string, err error, output string) {
		state.State, state.Step = "error", step
		state.Error = scrub(fmt.Sprintf("%v: %s", err, output), r.secrets)
		state.FinishedAt = time.Now().UTC().Format(time.RFC3339)
		state.DurationSec = time.Since(started).Seconds()
		backupMu.Lock()
		writeBackupState(state)
		backupMu.Unlock()
	}
	setStep := func(step string) {
		state.Step = step
		backupMu.Lock()
		writeBackupState(state)
		backupMu.Unlock()
	}

	ctx, cancel := context.WithTimeout(context.Background(), backupTimeout)
	defer cancel()

	setStep("prepare")
	if err := ensureRestic(r); err != nil {
		fail("prepare", err, "")
		return
	}

	setStep("check_repository")
	if out, err := r.runPlain(ctx, "cat", "config", "--no-lock"); err != nil {
		// Exit code 10 (restic >= 0.17) / "does not exist" means a fresh repository.
		var exitErr *exec.ExitError
		missing := strings.Contains(out, "does not exist") || strings.Contains(out, "Is there a repository at") ||
			(asExit(err, &exitErr) && exitErr.ExitCode() == 10)
		if !missing {
			fail("check_repository", err, out)
			return
		}
		setStep("init_repository")
		if out, err := r.runPlain(ctx, "init"); err != nil {
			fail("init_repository", err, out)
			return
		}
	}

	setStep("backup")
	args := []string{"backup", "--json", "--tag", "support-agent"}
	if r.useVSS && runtime.GOOS == "windows" {
		args = append(args, "--use-fs-snapshot")
	}
	if r.limitKbps > 0 {
		args = append(args, "--limit-upload", fmt.Sprint(r.limitKbps))
	}
	for _, e := range r.excludes {
		args = append(args, "--exclude", e)
	}
	args = append(args, "--")
	args = append(args, r.paths...)

	cmd := r.restic(ctx, args...)
	stdout, _ := cmd.StdoutPipe()
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		fail("backup", err, "")
		return
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 1<<20), 8<<20)
	for scanner.Scan() {
		var line struct {
			MessageType         string  `json:"message_type"`
			FilesNew            int64   `json:"files_new"`
			FilesChanged        int64   `json:"files_changed"`
			DataAdded           int64   `json:"data_added"`
			TotalBytesProcessed int64   `json:"total_bytes_processed"`
			SnapshotID          string  `json:"snapshot_id"`
			TotalDuration       float64 `json:"total_duration"`
		}
		if json.Unmarshal(scanner.Bytes(), &line) == nil && line.MessageType == "summary" {
			state.SnapshotID, state.FilesNew, state.FilesChanged = line.SnapshotID, line.FilesNew, line.FilesChanged
			state.BytesAdded, state.BytesTotal = line.DataAdded, line.TotalBytesProcessed
		}
	}
	// Exit code 3 = some source files could not be read (locked/permission) but
	// a snapshot was still created: report success with a warning, not failure.
	if err := cmd.Wait(); err != nil {
		var exitErr *exec.ExitError
		if !(asExit(err, &exitErr) && exitErr.ExitCode() == 3 && state.SnapshotID != "") {
			fail("backup", err, stderr.String())
			return
		}
		state.Error = "some files could not be read: " + scrub(stderr.String(), r.secrets)
	}

	setStep("forget")
	if out, err := r.runPlain(ctx, "forget", "--prune", "--tag", "support-agent",
		"--keep-daily", fmt.Sprint(r.keepDaily), "--keep-weekly", fmt.Sprint(r.keepWeekly),
		"--keep-monthly", fmt.Sprint(r.keepMonth)); err != nil {
		// The snapshot exists; only retention failed. Surface it but keep success.
		state.Error = scrub("retention failed: "+err.Error()+": "+out, r.secrets)
	}

	state.State, state.Step = "success", "done"
	state.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	state.DurationSec = time.Since(started).Seconds()
	backupMu.Lock()
	writeBackupState(state)
	backupMu.Unlock()
}

func asExit(err error, target **exec.ExitError) bool {
	e, ok := err.(*exec.ExitError)
	if ok {
		*target = e
	}
	return ok
}

// BackupRun validates the request and starts the backup in the background.
func BackupRun(params map[string]any) (map[string]any, error) {
	r, err := parseBackupRequest(params)
	if err != nil {
		return nil, err
	}
	backupMu.Lock()
	if rs := readRestoreState(); rs.State == "running" {
		backupMu.Unlock()
		return nil, fmt.Errorf("a restore is running; backup will run after it finishes")
	}
	if cur := readBackupState(); cur.State == "running" {
		if started, perr := time.Parse(time.RFC3339, cur.StartedAt); perr == nil && time.Since(started) < backupTimeout {
			backupMu.Unlock()
			return nil, fmt.Errorf("a backup is already running (started %s)", cur.StartedAt)
		}
	}
	state := backupState{State: "running", StartedAt: time.Now().UTC().Format(time.RFC3339), Step: "queued"}
	writeBackupState(state)
	backupMu.Unlock()

	go runBackupJob(r, state)
	return map[string]any{"started": true, "started_at": state.StartedAt, "paths": len(r.paths)}, nil
}
