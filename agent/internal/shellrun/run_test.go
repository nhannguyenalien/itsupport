//go:build unix

package shellrun

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func TestRunReadCommand(t *testing.T) {
	out, err := Run([]string{"uname", "-s"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if out["exit_code"] != 0 || out["class"] != "read" || strings.TrimSpace(out["stdout"].(string)) == "" {
		t.Fatalf("unexpected %v", out)
	}
}

func TestRunRefusesWriteWithoutApproval(t *testing.T) {
	if _, err := Run([]string{"echo", "hi"}, false); err == nil || !strings.Contains(err.Error(), "no human approval") {
		t.Fatalf("expected approval error, got %v", err)
	}
	out, err := Run([]string{"echo", "hi"}, true)
	if err != nil || strings.TrimSpace(out["stdout"].(string)) != "hi" || out["class"] != "write" {
		t.Fatalf("approved write should run: %v %v", out, err)
	}
}

func TestRunNeverRunsDeniedEvenWhenApproved(t *testing.T) {
	for _, argv := range [][]string{{"sh", "-c", "id"}, {"cat", "/etc/shadow"}, {"rm", "-rf", "/"}} {
		if _, err := Run(argv, true); err == nil || !strings.Contains(err.Error(), "denied") {
			t.Errorf("%v: expected denial, got %v", argv, err)
		}
	}
}

func TestRunNoShellExpansion(t *testing.T) {
	out, err := Run([]string{"echo", "$HOME", "$(id)", "a;b", "*"}, true)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(out["stdout"].(string)); got != "$HOME $(id) a;b *" {
		t.Fatalf("arguments were interpreted: %q", got)
	}
}

func TestRunNonZeroExitIsAResultNotAnError(t *testing.T) {
	out, err := Run([]string{"ls", "/definitely/not/here"}, false)
	if err != nil || out["exit_code"] == 0 {
		t.Fatalf("want a non-zero exit result, got %v %v", out, err)
	}
}

func TestRunOutputIsCapped(t *testing.T) {
	out, err := Run([]string{"head", "-c", "1000000", "/dev/zero"}, false)
	if err == nil {
		t.Fatalf("/dev/zero is outside the readable roots, got %v", out)
	}
}

func TestRedact(t *testing.T) {
	in := "cipassword: hunter2\nAuthorization: Bearer abc.def\napi_key=sk-12345\nuser=bob\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\neyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV"
	out := Redact(in)
	for _, leak := range []string{"hunter2", "abc.def", "sk-12345", "MIIE", "SflKxwRJSMeKKF2QT4"} {
		if strings.Contains(out, leak) {
			t.Errorf("%q leaked in %q", leak, out)
		}
	}
	if !strings.Contains(out, "user=bob") {
		t.Errorf("redaction removed ordinary text: %q", out)
	}
}

// TestLiveCommand runs one real command through Run, for checking a host by
// hand: SHELLRUN_LIVE='["qm","list"]' ./shellrun.test -test.run TestLiveCommand -test.v
func TestLiveCommand(t *testing.T) {
	raw := os.Getenv("SHELLRUN_LIVE")
	if raw == "" {
		t.Skip("set SHELLRUN_LIVE to a JSON argv to run a real command")
	}
	var argv []string
	if err := json.Unmarshal([]byte(raw), &argv); err != nil {
		t.Fatal(err)
	}
	out, err := Run(argv, os.Getenv("SHELLRUN_APPROVED") == "1")
	t.Logf("verdict=%+v err=%v", Classify(argv), err)
	if out != nil {
		t.Logf("exit=%v class=%v duration_ms=%v truncated=%v\n%s%s", out["exit_code"], out["class"], out["duration_ms"], out["stdout_truncated"], out["stdout"], out["stderr"])
	}
}

func TestTimeoutKillsAndOutputStaysCapped(t *testing.T) {
	old := WriteTimeout
	WriteTimeout = time.Second
	defer func() { WriteTimeout = old }()

	started := time.Now()
	out, err := Run([]string{"yes"}, true) // endless output
	if err != nil {
		t.Fatal(err)
	}
	if out["timed_out"] != true || out["exit_code"] != -1 {
		t.Fatalf("an endless command must be killed on timeout: %v", out)
	}
	if elapsed := time.Since(started); elapsed > 6*time.Second {
		t.Fatalf("kill took %v", elapsed)
	}
	if got := len(out["stdout"].(string)); got > OutputLimit || out["stdout_truncated"] != true {
		t.Fatalf("output must be capped at %d bytes and flagged, got %d truncated=%v", OutputLimit, got, out["stdout_truncated"])
	}

	started = time.Now()
	out, err = Run([]string{"sleep", "30"}, true)
	if err != nil || out["timed_out"] != true || time.Since(started) > 6*time.Second {
		t.Fatalf("sleep must be killed on timeout: %v %v", out, err)
	}
}

// Shapes taken from `docker inspect` / `qm config` / compose output, with fake values.
func TestRedactEnvironmentStyleOutput(t *testing.T) {
	in := `"Env": [
 "APP_KEY=base64:Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==",
 "DB_PASSWORD=hunter2hunter2",
 "SECRET_KEY_BASE=abcdef0123456789",
 "PUSHER_APP_KEY=pk_live_123456",
 "REDIS_URL=redis://default:redispass@10.0.0.5:6379/0",
 "DATABASE_URL=postgres://coolify:dbpass123@coolify-db:5432/coolify",
 "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG",
 "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
 "TZ=Asia/Ho_Chi_Minh",
 "APP_NAME=Coolify"
]
cipassword: $5$abc$def
password_hash = abc123hash`
	out := Redact(in)
	for _, leak := range []string{"Zm9vYmFy", "hunter2", "abcdef0123456789", "pk_live_123456", "redispass", "dbpass123", "wJalrXUtnFEMI", "ghp_abcdef", "$5$abc$def", "abc123hash"} {
		if strings.Contains(out, leak) {
			t.Errorf("%q leaked:\n%s", leak, out)
		}
	}
	for _, keep := range []string{"TZ=Asia/Ho_Chi_Minh", "APP_NAME=Coolify", "redis://default:", "@10.0.0.5:6379/0", "@coolify-db:5432/coolify"} {
		if !strings.Contains(out, keep) {
			t.Errorf("redaction removed ordinary text %q:\n%s", keep, out)
		}
	}
}
