//go:build linux

package tools

import (
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

var linuxServiceName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.@:-]{0,200}$`)

func serviceUnit(params map[string]any) (string, error) {
	name, err := requireStringParam(params, "service_name")
	if err != nil {
		return "", err
	}
	if !linuxServiceName.MatchString(name) {
		return "", fmt.Errorf("invalid service name")
	}
	if !strings.HasSuffix(name, ".service") {
		name += ".service"
	}
	return name, nil
}

func systemctl(args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	// Fixed executable and separate validated arguments; never invokes a shell.
	out, err := exec.CommandContext(ctx, "/usr/bin/systemctl", args...).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("systemctl: %w: %.1024s", err, out)
	}
	return strings.TrimSpace(string(out)), nil
}

func ServiceStatus(params map[string]any) (map[string]any, error) {
	name, err := serviceUnit(params)
	if err != nil {
		return nil, err
	}
	out, err := systemctl("show", "--property=LoadState,ActiveState,SubState", "--", name)
	if err != nil {
		return nil, err
	}
	result := map[string]any{"service_name": name}
	for _, line := range strings.Split(out, "\n") {
		key, value, ok := strings.Cut(line, "=")
		if ok {
			result[key] = value
		}
	}
	if result["LoadState"] == "not-found" {
		return nil, fmt.Errorf("service %q not found", name)
	}
	result["state"] = "STOPPED"
	if result["ActiveState"] == "active" {
		result["state"] = "RUNNING"
	}
	return result, nil
}

func restartableService(name string) bool {
	// Protect this connection and host/virtualization infrastructure. Never turn a
	// service restart approval into rebooting a host or interrupting its guests.
	for _, prefix := range []string{"itsupport-", "meshagent", "ssh", "systemd-", "dbus", "network", "pve", "qemu", "lxc", "corosync", "ceph", "zfs", "lvm", "docker", "containerd"} {
		if strings.HasPrefix(strings.ToLower(name), prefix) {
			return false
		}
	}
	return true
}

// ServiceRestart uses the existing medium-risk human approval and verification
// chain. Local infrastructure protection applies even after approval.
func ServiceRestart(params map[string]any) (map[string]any, error) {
	name, err := serviceUnit(params)
	if err != nil {
		return nil, err
	}
	if !restartableService(name) {
		return nil, fmt.Errorf("protected infrastructure service %q; technician support required", name)
	}
	if _, err = ServiceStatus(params); err != nil {
		return nil, err
	}
	if _, err = systemctl("restart", "--", name); err != nil {
		return nil, err
	}
	status, err := ServiceStatus(params)
	if err != nil {
		return nil, err
	}
	if status["state"] != "RUNNING" {
		return nil, fmt.Errorf("service %q is not active after restart", name)
	}
	return status, nil
}
