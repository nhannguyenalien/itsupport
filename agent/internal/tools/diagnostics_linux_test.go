//go:build linux

package tools

import "testing"

func TestLinuxDiagnostics(t *testing.T) {
	disk, err := DiskUsage(nil)
	if err != nil {
		t.Fatal(err)
	}
	if disk["total_gb"].(float64) <= 0 || disk["used_percent"].(float64) < 0 {
		t.Fatal(disk)
	}
	if _, err := DiskUsage(map[string]any{"drive": "/does-not-exist-itsupport"}); err == nil {
		t.Fatal("missing path accepted")
	}
	info, err := SystemInfo(nil)
	if err != nil {
		t.Fatal(err)
	}
	if info["cpu_usage_pct"].(float64) < 0 || info["cpu_usage_pct"].(float64) > 100 {
		t.Fatal(info)
	}
	if info["available_memory_gb"].(float64) > info["total_memory_gb"].(float64) {
		t.Fatal(info)
	}
}

func TestLinuxMemoryUsesAvailableNotFree(t *testing.T) {
	mem, err := linuxMemory("MemTotal: 1000 kB\nMemFree: 10 kB\nMemAvailable: 600 kB\n")
	if err != nil || mem["MemAvailable"] != 600 {
		t.Fatal(mem, err)
	}
	for _, data := range []string{"", "MemTotal: 100 kB", "MemTotal: 100 kB\nMemAvailable: 200 kB"} {
		if _, err := linuxMemory(data); err == nil {
			t.Fatalf("accepted invalid memory %q", data)
		}
	}
}

func TestLinuxServiceValidation(t *testing.T) {
	for _, name := range []string{"--all", "nginx; reboot", "a\nb", "*", "../nginx", "$(reboot)"} {
		if _, err := serviceUnit(map[string]any{"service_name": name}); err == nil {
			t.Fatalf("accepted %q", name)
		}
	}
	for _, name := range []string{"ssh", "pvedaemon", "itsupport-executor", "networking", "docker"} {
		if _, err := ServiceRestart(map[string]any{"service_name": name}); err == nil {
			t.Fatalf("accepted protected %q", name)
		}
	}
	name, err := serviceUnit(map[string]any{"service_name": "nginx"})
	if err != nil || name != "nginx.service" || !restartableService(name) {
		t.Fatal(name, err)
	}
}
