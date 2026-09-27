//go:build darwin

package tools

import (
	"bufio"
	"bytes"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// ProcessList enumerates running processes via `ps -axo pid=,ppid=,comm=` —
// a FIXED, parameterless invocation of a standard macOS utility, not
// arbitrary script execution (same principle already established for this
// OS by desktop_darwin.go's screencapture(1) call and
// customerview_darwin.go's `open`: no caller input ever reaches the command
// line). There's no equivalent native syscall as simple as Windows'
// CreateToolhelp32Snapshot readily available without cgo, so this is the
// pragmatic match for the existing macOS-tool style in this file set.
// Deliberately returns only pid/parent_pid/name — NOT the full command line,
// same data-privacy reasoning as process_windows.go.
func ProcessList(params map[string]any) (map[string]any, error) {
	cmd := exec.Command("ps", "-axo", "pid=,ppid=,comm=")
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("ps: %w", err)
	}

	processes := make([]map[string]any, 0, 128)
	scanner := bufio.NewScanner(&out)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 3 {
			continue
		}
		pid, err1 := strconv.Atoi(fields[0])
		ppid, err2 := strconv.Atoi(fields[1])
		if err1 != nil || err2 != nil {
			continue // malformed line — skip rather than fail the whole scan
		}
		processes = append(processes, map[string]any{
			"pid":        pid,
			"parent_pid": ppid,
			// comm can itself contain spaces (e.g. an app bundle's full
			// executable path) — everything after the first two numeric
			// fields is the name.
			"name": strings.Join(fields[2:], " "),
		})
	}

	return map[string]any{"processes": processes, "count": len(processes)}, nil
}
