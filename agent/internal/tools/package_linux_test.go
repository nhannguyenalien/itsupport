//go:build linux

package tools

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestPackageNameRejectsShellAndAptExpressions(t *testing.T) {
	for _, name := range []string{"", "-y", "lm-sensors;reboot", "$(id)", "./test.deb", "https://x/a.deb", "foo*", "foo=1", "foo bar", "foo\nbar"} {
		if _, err := packageName(map[string]any{"package_name": name}); err == nil {
			t.Fatalf("accepted %q", name)
		}
	}
	if _, err := packageName(map[string]any{"package_name": "lm-sensors"}); err != nil {
		t.Fatal(err)
	}
}
func TestPackageInstallPlanAndVerification(t *testing.T) {
	var calls int
	run := func(_ time.Duration, exe string, args ...string) (string, error) {
		calls++
		switch calls {
		case 1:
			return "dpkg-query: no packages found matching lm-sensors", errors.New("exit 1")
		case 2:
			if exe != "/usr/bin/apt-get" || args[0] != "--simulate" {
				t.Fatal(exe, args)
			}
			return "Inst lm-sensors (1:3.6.2-2 Debian:13.7/stable [amd64])\n", nil
		case 3:
			if exe != "/usr/bin/apt-get" || !reflect.DeepEqual(args[len(args)-3:], []string{"install", "--", "lm-sensors"}) {
				t.Fatal(exe, args)
			}
			for _, flag := range []string{"--no-remove", "--no-upgrade", "--no-install-recommends"} {
				if !strings.Contains(strings.Join(args, " "), flag) {
					t.Fatal(flag)
				}
			}
			return "done", nil
		case 4:
			return "installed\t1.0", nil
		}
		t.Fatal("unexpected call")
		return "", nil
	}
	result, err := packageInstallWith(map[string]any{"package_name": "lm-sensors"}, run)
	if err != nil || result["installed"] != true || calls != 4 {
		t.Fatal(result, err, calls)
	}
}
func TestPackageInstallRejectsDangerousPlans(t *testing.T) {
	for _, plan := range []string{"Remv proxmox-ve [9]", "Inst libc6 [2.0] (3.0 Debian)"} {
		calls := 0
		_, err := packageInstallWith(map[string]any{"package_name": "lm-sensors"}, func(_ time.Duration, _ string, _ ...string) (string, error) {
			calls++
			if calls == 1 {
				return "not-installed", nil
			}
			return plan, nil
		})
		if err == nil || calls != 2 {
			t.Fatal(plan, err, calls)
		}
	}
}
func TestPackageInstallAlreadyInstalledDoesNotMutate(t *testing.T) {
	calls := 0
	result, err := packageInstallWith(map[string]any{"package_name": "lm-sensors"}, func(_ time.Duration, _ string, _ ...string) (string, error) { calls++; return "installed\t1", nil })
	if err != nil || result["already_installed"] != true || calls != 1 {
		t.Fatal(result, err, calls)
	}
}
