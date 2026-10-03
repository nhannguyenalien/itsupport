//go:build windows

package tools

import (
	"fmt"
	"runtime"
	"sort"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// system.performance — "máy chậm / CPU-RAM 100%" diagnosis. Samples CPU over
// a short window and aggregates per-process CPU and working set by image
// name (Chrome/Edge/Teams spawn many processes; the user thinks of them as
// one app). Names only — never command lines (docs/v0.1-spec.md privacy).

var (
	procGetSystemTimes       = kernel32.NewProc("GetSystemTimes")
	procGetTickCount64       = kernel32.NewProc("GetTickCount64")
	procK32GetProcessMemInfo = kernel32.NewProc("K32GetProcessMemoryInfo")
)

const performanceSampleWindow = 1500 * time.Millisecond

// PROCESS_MEMORY_COUNTERS — 72 bytes (amd64).
type processMemoryCounters struct {
	cb                         uint32
	pageFaultCount             uint32
	peakWorkingSetSize         uintptr
	workingSetSize             uintptr
	quotaPeakPagedPoolUsage    uintptr
	quotaPagedPoolUsage        uintptr
	quotaPeakNonPagedPoolUsage uintptr
	quotaNonPagedPoolUsage     uintptr
	pagefileUsage              uintptr
	peakPagefileUsage          uintptr
}

func filetimeTicks(ft windows.Filetime) uint64 {
	return uint64(ft.HighDateTime)<<32 | uint64(ft.LowDateTime)
}

func systemTimes() (idle, kernel, user uint64, err error) {
	var i, k, u windows.Filetime
	ret, _, callErr := procGetSystemTimes.Call(uintptr(unsafe.Pointer(&i)), uintptr(unsafe.Pointer(&k)), uintptr(unsafe.Pointer(&u)))
	if ret == 0 {
		return 0, 0, 0, fmt.Errorf("GetSystemTimes: %w", callErr)
	}
	return filetimeTicks(i), filetimeTicks(k), filetimeTicks(u), nil
}

type processSample struct {
	name       string
	cpuTicks   uint64
	workingSet uint64
}

func sampleProcesses() map[uint32]processSample {
	out := make(map[uint32]processSample, 256)
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return out
	}
	defer windows.CloseHandle(snapshot)
	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	for err := windows.Process32First(snapshot, &entry); err == nil; err = windows.Process32Next(snapshot, &entry) {
		pid := entry.ProcessID
		sample := processSample{name: windows.UTF16ToString(entry.ExeFile[:])}
		if pid != 0 {
			if h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid); err == nil {
				var created, exited, kernel, user windows.Filetime
				if windows.GetProcessTimes(h, &created, &exited, &kernel, &user) == nil {
					sample.cpuTicks = filetimeTicks(kernel) + filetimeTicks(user)
				}
				var mem processMemoryCounters
				mem.cb = uint32(unsafe.Sizeof(mem))
				if ret, _, _ := procK32GetProcessMemInfo.Call(uintptr(h), uintptr(unsafe.Pointer(&mem)), uintptr(mem.cb)); ret != 0 {
					sample.workingSet = uint64(mem.workingSetSize)
				}
				windows.CloseHandle(h)
			}
		}
		out[pid] = sample
	}
	return out
}

type appUsage struct {
	Name       string  `json:"name"`
	Processes  int     `json:"processes"`
	CPUPercent float64 `json:"cpu_percent"`
	MemoryMB   float64 `json:"memory_mb"`
}

func round1(v float64) float64 { return float64(int64(v*10+0.5)) / 10 }

// SystemPerformance reports overall CPU %, memory pressure, uptime and the
// heaviest apps by CPU and by memory.
func SystemPerformance(params map[string]any) (map[string]any, error) {
	idle0, kernel0, user0, err := systemTimes()
	if err != nil {
		return nil, err
	}
	before := sampleProcesses()
	start := time.Now()
	time.Sleep(performanceSampleWindow)
	idle1, kernel1, user1, err := systemTimes()
	if err != nil {
		return nil, err
	}
	after := sampleProcesses()
	elapsedTicks := float64(time.Since(start).Nanoseconds()/100) * float64(runtime.NumCPU())

	total := float64((kernel1 - kernel0) + (user1 - user0)) // kernel time includes idle
	cpu := 0.0
	if total > 0 {
		cpu = 100 * (1 - float64(idle1-idle0)/total)
	}

	apps := map[string]*appUsage{}
	for pid, s := range after {
		if pid == 0 {
			continue // System Idle Process
		}
		key := strings.ToLower(s.name)
		a := apps[key]
		if a == nil {
			a = &appUsage{Name: s.name}
			apps[key] = a
		}
		a.Processes++
		a.MemoryMB += float64(s.workingSet) / (1024 * 1024)
		if prev, ok := before[pid]; ok && prev.name == s.name && s.cpuTicks >= prev.cpuTicks && elapsedTicks > 0 {
			a.CPUPercent += 100 * float64(s.cpuTicks-prev.cpuTicks) / elapsedTicks
		}
	}
	list := make([]appUsage, 0, len(apps))
	for _, a := range apps {
		a.CPUPercent = round1(a.CPUPercent)
		a.MemoryMB = round1(a.MemoryMB)
		list = append(list, *a)
	}
	top := func(less func(a, b appUsage) bool) []appUsage {
		sorted := append([]appUsage(nil), list...)
		sort.Slice(sorted, func(i, j int) bool { return less(sorted[i], sorted[j]) })
		if len(sorted) > 10 {
			sorted = sorted[:10]
		}
		return sorted
	}

	mem, err := globalMemoryStatusEx()
	if err != nil {
		return nil, err
	}
	uptimeMs, _, _ := procGetTickCount64.Call()
	const gb = 1024 * 1024 * 1024
	return map[string]any{
		"cpu_percent":                 round1(cpu),
		"cpu_count":                   runtime.NumCPU(),
		"sample_seconds":              performanceSampleWindow.Seconds(),
		"memory_load_percent":         mem.MemoryLoad,
		"memory_total_gb":             round1(float64(mem.TotalPhys) / gb),
		"memory_available_gb":         round1(float64(mem.AvailPhys) / gb),
		"commit_used_gb":              round1(float64(mem.TotalPageFile-mem.AvailPageFile) / gb),
		"commit_limit_gb":             round1(float64(mem.TotalPageFile) / gb),
		"uptime_hours":                round1(float64(uptimeMs) / 3_600_000),
		"process_count":               len(after),
		"top_cpu":                     top(func(a, b appUsage) bool { return a.CPUPercent > b.CPUPercent }),
		"top_memory":                  top(func(a, b appUsage) bool { return a.MemoryMB > b.MemoryMB }),
		"cpu_percent_is_of_all_cores": true,
	}, nil
}
