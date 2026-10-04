package tools

import (
	"os"
	"path/filepath"
	"testing"
)

func validBackupParams() map[string]any {
	return map[string]any{
		"repo":  "rest:https://backup.example.com/dev1",
		"env":   map[string]any{"RESTIC_PASSWORD": "s3cret-pass"},
		"paths": []any{"/data", "/home"},
	}
}

func TestParseBackupRequestAccepts(t *testing.T) {
	r, err := parseBackupRequest(validBackupParams())
	if err != nil {
		t.Fatal(err)
	}
	if r.keepDaily != 7 || len(r.paths) != 2 || len(r.env) != 1 {
		t.Fatalf("unexpected defaults: %+v", r)
	}
}

func TestParseBackupRequestRejects(t *testing.T) {
	cases := map[string]func(p map[string]any){
		"bad scheme":      func(p map[string]any) { p["repo"] = "sftp:user@host:/repo" },
		"local repo":      func(p map[string]any) { p["repo"] = "/tmp/repo" },
		"no password":     func(p map[string]any) { p["env"] = map[string]any{"AWS_ACCESS_KEY_ID": "x"} },
		"forbidden env":   func(p map[string]any) { p["env"] = map[string]any{"RESTIC_PASSWORD": "pw", "PATH": "/evil"} },
		"relative path":   func(p map[string]any) { p["paths"] = []any{"docs"} },
		"flag-like path":  func(p map[string]any) { p["paths"] = []any{"-r"} },
		"no paths":        func(p map[string]any) { p["paths"] = []any{} },
		"flag-like excl":  func(p map[string]any) { p["excludes"] = []any{"--password-command=calc"} },
		"zero retention":  func(p map[string]any) { p["keep_daily"], p["keep_weekly"], p["keep_monthly"] = 0.0, 0.0, 0.0 },
		"fractional keep": func(p map[string]any) { p["keep_daily"] = 1.5 },
	}
	for name, mutate := range cases {
		p := validBackupParams()
		mutate(p)
		if _, err := parseBackupRequest(p); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestScrubRemovesSecrets(t *testing.T) {
	got := scrub("failed with password hunter2xyz on repo", []string{"hunter2xyz"})
	if got != "failed with password *** on repo" {
		t.Fatalf("secret leaked: %q", got)
	}
}

func TestValidateRestoreTarget(t *testing.T) {
	good := t.TempDir() + "/restore-1"
	if _, err := validateRestoreTarget(good); err != nil {
		t.Fatalf("new directory rejected: %v", err)
	}
	nonEmpty := t.TempDir()
	if err := os.WriteFile(nonEmpty+"/a.txt", []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	for name, target := range map[string]string{
		"relative": "restore", "empty": "", "root": "/", "non-empty": nonEmpty,
		"agent dir": filepath.Join(backupDir(), "x"), "etc": "/etc/restore",
	} {
		if _, err := validateRestoreTarget(target); err == nil {
			t.Errorf("%s: expected rejection", name)
		}
	}
}

func TestRestoreRequestValidation(t *testing.T) {
	p := validBackupParams()
	p["snapshot_id"] = "--password-command=calc"
	p["target"] = t.TempDir() + "/r"
	if _, err := BackupRestore(p); err == nil {
		t.Fatal("flag-like snapshot id accepted")
	}
	p["snapshot_id"] = "deadbeef"
	p["include"] = []any{"-x"}
	if _, err := BackupRestore(p); err == nil {
		t.Fatal("flag-like include accepted")
	}
}
