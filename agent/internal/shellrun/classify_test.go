package shellrun

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

type fixture struct {
	Argv  []string `json:"argv"`
	Class Class    `json:"class"`
	Note  string   `json:"note"`
}

func TestClassifyFixtures(t *testing.T) {
	raw, err := os.ReadFile("testdata/classify.json")
	if err != nil {
		t.Fatal(err)
	}
	var rows []fixture
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		got := Classify(row.Argv)
		if got.Class != row.Class {
			t.Errorf("%q: got %s (%s: %s), want %s %s", strings.Join(row.Argv, " "), got.Class, got.Rule, got.Reason, row.Class, row.Note)
		}
	}
}

func TestEveryReadRuleIsExercised(t *testing.T) {
	raw, _ := os.ReadFile("testdata/classify.json")
	var rows []fixture
	_ = json.Unmarshal(raw, &rows)
	hit := map[string]bool{}
	for _, row := range rows {
		if v := Classify(row.Argv); v.Class == Read {
			hit[v.Rule] = true
		}
	}
	for _, rule := range loaded.Read {
		if !hit[rule.ID] {
			t.Errorf("read rule %q has no fixture that exercises it", rule.ID)
		}
	}
}

func TestResolvedPathCheck(t *testing.T) {
	for p, content := range map[string]bool{"/etc/shadow": true, "/root/.ssh/id_rsa": false, "/etc/itsupport-agent/config.json": true, "/proc/1/environ": true, "/tmp/x": true, "/run/credentials/x/y": true, "/root/notes.txt": true} {
		if PathAllowedAfterResolve(p, content) {
			t.Errorf("%s should be rejected after resolution", p)
		}
	}
	for p, content := range map[string]bool{"/var/log/syslog": true, "/etc/hostname": true, "/home": false, "/": false, "/usr/lib/os-release": true, "/run/systemd/resolve/stub-resolv.conf": true} {
		if !PathAllowedAfterResolve(p, content) {
			t.Errorf("%s should be allowed", p)
		}
	}
}
