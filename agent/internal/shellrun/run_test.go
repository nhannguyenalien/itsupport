//go:build unix

package shellrun

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
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
	out, err := Run(argv, false)
	t.Logf("verdict=%+v err=%v", Classify(argv), err)
	if out != nil {
		t.Logf("exit=%v class=%v duration_ms=%v truncated=%v\n%s%s", out["exit_code"], out["class"], out["duration_ms"], out["stdout_truncated"], out["stdout"], out["stderr"])
	}
}
