//go:build linux

package tools

import (
	"bufio"
	"bytes"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// ProcessList uses a fixed ps invocation and omits command arguments that may contain secrets.
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
