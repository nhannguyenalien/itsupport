//go:build linux

package tools

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

var linuxPackageName = regexp.MustCompile(`^[a-z0-9][a-z0-9+.-]{1,127}$`)

func packageName(params map[string]any) (string, error) {
	name, err := requireStringParam(params, "package_name")
	if err != nil {
		return "", err
	}
	if !linuxPackageName.MatchString(name) {
		return "", fmt.Errorf("package_name must be one exact repository package name")
	}
	return name, nil
}

type packageRunner func(time.Duration, string, ...string) (string, error)

// Keep output bounded even if a repository or maintainer script is noisy.
type packageOutput struct{ data []byte }

func (b *packageOutput) Write(p []byte) (int, error) {
	n := len(p)
	if remaining := 64*1024 - len(b.data); remaining > 0 {
		if len(p) > remaining {
			p = p[:remaining]
		}
		b.data = append(b.data, p...)
	}
	return n, nil
}
func runPackageCommand(timeout time.Duration, executable string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Env = append(os.Environ(), "LC_ALL=C", "DEBIAN_FRONTEND=noninteractive", "NEEDRESTART_MODE=l")
	// Ask apt to stop gracefully on timeout; wait for its children to release pipes.
	cmd.Cancel = func() error { return cmd.Process.Signal(os.Interrupt) }
	cmd.WaitDelay = 30 * time.Second
	var out packageOutput
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	if ctx.Err() != nil {
		return string(out.data), fmt.Errorf("package command timed out; check package.status before retrying")
	}
	return string(out.data), err
}
func packageStatusWith(params map[string]any, run packageRunner) (map[string]any, error) {
	name, err := packageName(params)
	if err != nil {
		return nil, err
	}
	out, err := run(15*time.Second, "/usr/bin/dpkg-query", "-W", "-f=${db:Status-Status}\t${Version}", "--", name)
	if err != nil {
		if strings.Contains(out, "no packages found matching") {
			return map[string]any{"package_name": name, "installed": false}, nil
		}
		return nil, fmt.Errorf("dpkg-query unavailable or failed (Debian/Ubuntu/Proxmox required): %w: %.1024s", err, out)
	}
	fields := strings.SplitN(strings.TrimSpace(out), "\t", 2)
	result := map[string]any{"package_name": name, "installed": fields[0] == "installed"}
	if len(fields) > 1 {
		result["version"] = fields[1]
	}
	return result, nil
}
func PackageStatus(params map[string]any) (map[string]any, error) {
	return packageStatusWith(params, runPackageCommand)
}

func safePackagePlan(out string) error {
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "Remv ") || (regexp.MustCompile(`^Inst \S+ \[`).MatchString(line)) {
			return fmt.Errorf("installation would remove or upgrade existing packages; technician review required")
		}
	}
	return nil
}
func packageInstallWith(params map[string]any, run packageRunner) (map[string]any, error) {
	name, err := packageName(params)
	if err != nil {
		return nil, err
	}
	status, err := packageStatusWith(params, run)
	if err != nil {
		return nil, err
	}
	if status["installed"] == true {
		status["already_installed"] = true
		return status, nil
	}
	args := []string{"--yes", "--no-remove", "--no-upgrade", "--no-install-recommends", "-o", "DPkg::Lock::Timeout=60", "-o", "Dpkg::Options::=--force-confold", "install", "--", name}
	plan, err := run(time.Minute, "/usr/bin/apt-get", append([]string{"--simulate"}, args...)...)
	if err != nil {
		return nil, fmt.Errorf("package unavailable or apt plan failed; no installation performed: %w: %.2048s", err, plan)
	}
	if !strings.Contains("\n"+plan, "\nInst "+name+" (") {
		return nil, fmt.Errorf("apt did not resolve the exact requested package; no installation performed")
	}
	if err = safePackagePlan(plan); err != nil {
		return nil, err
	}
	out, err := run(9*time.Minute, "/usr/bin/apt-get", args...)
	if err != nil {
		return nil, fmt.Errorf("apt installation failed; inspect package status before retrying: %w: %.4096s", err, out)
	}
	status, err = packageStatusWith(params, run)
	if err != nil {
		return nil, err
	}
	if status["installed"] != true {
		return nil, fmt.Errorf("apt finished but package is not installed")
	}
	return status, nil
}

// Backend queues this high-risk action only after explicit human approval.
func PackageInstall(params map[string]any) (map[string]any, error) {
	return packageInstallWith(params, runPackageCommand)
}
