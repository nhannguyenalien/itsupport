//go:build windows

package tools

import (
	"fmt"
	"strings"
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

var protectedProcessNames = map[string]struct{}{
	"system": {}, "registry": {}, "smss.exe": {}, "csrss.exe": {},
	"wininit.exe": {}, "services.exe": {}, "lsass.exe": {}, "winlogon.exe": {},
	"svchost.exe": {}, "dwm.exe": {}, "fontdrvhost.exe": {},
}

func processNameByPID(pid uint32) (string, error) {
	result, err := ProcessList(nil)
	if err != nil {
		return "", err
	}
	processes, _ := result["processes"].([]map[string]any)
	for _, process := range processes {
		if process["pid"] == pid {
			return strings.ToLower(fmt.Sprint(process["name"])), nil
		}
	}
	return "", fmt.Errorf("process %d was not found", pid)
}

// ProcessKill enforces a local critical-process denylist in addition to the
// backend check. Approval or a compromised backend can never override it.
func ProcessKill(params map[string]any) (map[string]any, error) {
	pidFloat, ok := params["pid"].(float64) // JSON numbers decode as float64
	if !ok || pidFloat <= 0 {
		return nil, fmt.Errorf("param %q must be a positive integer", "pid")
	}
	pid := uint32(pidFloat)
	if pid <= 4 {
		return nil, fmt.Errorf("refusing to terminate protected Windows process PID %d", pid)
	}
	name, err := processNameByPID(pid)
	if err != nil {
		return nil, err
	}
	if _, protected := protectedProcessNames[name]; protected {
		return nil, fmt.Errorf("refusing to terminate protected Windows process %s (PID %d)", name, pid)
	}

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
