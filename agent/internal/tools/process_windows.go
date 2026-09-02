//go:build windows

package tools

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ProcessList enumerates running processes via CreateToolhelp32Snapshot — a
// native Win32 API, not a shelled-out `tasklist`/PowerShell call (spec:
// no arbitrary script execution, compiled actions only). Deliberately returns
// only name/pid/parent_pid — NOT full command line, which can carry secrets.
// See docs/v0.1-spec.md "Data privacy v0.1".
func ProcessList(params map[string]any) (map[string]any, error) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, fmt.Errorf("create process snapshot: %w", err)
	}
	defer windows.CloseHandle(snapshot)

	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))

	if err := windows.Process32First(snapshot, &entry); err != nil {
		return nil, fmt.Errorf("enumerate first process: %w", err)
	}

	processes := make([]map[string]any, 0, 128)
	for {
		processes = append(processes, map[string]any{
			"pid":        entry.ProcessID,
			"parent_pid": entry.ParentProcessID,
			"name":       windows.UTF16ToString(entry.ExeFile[:]),
		})
		if err := windows.Process32Next(snapshot, &entry); err != nil {
			break // ERROR_NO_MORE_FILES is the expected way this loop ends
		}
	}

	return map[string]any{"processes": processes, "count": len(processes)}, nil
}

// ProcessKill terminates a process by PID. Write action, risk "high" in
// registry.json — no scope limiter on which PID beyond what already passed
// approval upstream. The agent does not maintain a "protected process" denylist
// in v0.1; that's a real gap worth closing before broader rollout (killing
// something like a critical system PID has no undo), tracked here rather than
// silently assumed safe.
func ProcessKill(params map[string]any) (map[string]any, error) {
	pidFloat, ok := params["pid"].(float64) // JSON numbers decode as float64
	if !ok || pidFloat <= 0 {
		return nil, fmt.Errorf("param %q must be a positive integer", "pid")
	}
	pid := uint32(pidFloat)

	handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, pid)
	if err != nil {
		return nil, fmt.Errorf("open process %d: %w", pid, err)
	}
	defer windows.CloseHandle(handle)

	if err := windows.TerminateProcess(handle, 1); err != nil {
		return nil, fmt.Errorf("terminate process %d: %w", pid, err)
	}

	return map[string]any{"pid": pid, "terminated": true}, nil
}
