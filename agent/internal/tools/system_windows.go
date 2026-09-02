//go:build windows

package tools

import (
	"fmt"
	"os"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

// memoryStatusEx mirrors the Win32 MEMORYSTATUSEX struct. golang.org/x/sys/windows
// (the version pinned in go.mod) doesn't export a wrapper for
// GlobalMemoryStatusEx, so this calls kernel32.dll directly — still a native
// Win32 API call, not a shelled-out command, consistent with "no arbitrary
// PowerShell" (see docs/v0.1-spec.md).
type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

var (
	kernel32                 = windows.NewLazySystemDLL("kernel32.dll")
	procGlobalMemoryStatusEx = kernel32.NewProc("GlobalMemoryStatusEx")
)

func globalMemoryStatusEx() (memoryStatusEx, error) {
	var m memoryStatusEx
	m.Length = uint32(unsafe.Sizeof(m))
	ret, _, err := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&m)))
	if ret == 0 {
		return m, fmt.Errorf("GlobalMemoryStatusEx: %w", err)
	}
	return m, nil
}

// SystemInfo reports basic host facts used to build the AI's diagnostic
// context. Deliberately minimal — no per-process detail, no user-identifying
// data beyond hostname (which the backend already has from enrollment).
func SystemInfo(params map[string]any) (map[string]any, error) {
	hostname, err := os.Hostname()
	if err != nil {
		hostname = "unknown"
	}

	memStatus, err := globalMemoryStatusEx()
	if err != nil {
		return nil, fmt.Errorf("query memory status: %w", err)
	}

	const gb = 1024 * 1024 * 1024
	return map[string]any{
		"hostname":        hostname,
		"os":              "windows",
		"arch":            runtime.GOARCH,
		"cpu_count":       runtime.NumCPU(),
		"total_memory_gb": float64(memStatus.TotalPhys) / gb,
		"free_memory_gb":  float64(memStatus.AvailPhys) / gb,
		"memory_load_pct": memStatus.MemoryLoad,
	}, nil
}
