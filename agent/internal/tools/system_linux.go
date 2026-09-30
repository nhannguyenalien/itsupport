//go:build linux

package tools

import (
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"
)

func linuxCPU() (total, idle uint64, err error) {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0, 0, err
	}
	fields := strings.Fields(strings.SplitN(string(data), "\n", 2)[0])
	if len(fields) < 5 || fields[0] != "cpu" {
		return 0, 0, fmt.Errorf("invalid /proc/stat")
	}
	// guest and guest_nice are already included in user and nice.
	for i := 1; i < len(fields) && i <= 8; i++ {
		value, e := strconv.ParseUint(fields[i], 10, 64)
		if e != nil {
			return 0, 0, e
		}
		total += value
		if i == 4 || i == 5 {
			idle += value
		}
	}
	return
}

func linuxMemory(data string) (map[string]uint64, error) {
	values := map[string]uint64{}
	for _, line := range strings.Split(data, "\n") {
		fields := strings.Fields(line)
		if len(fields) != 3 || fields[2] != "kB" {
			continue
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			return nil, err
		}
		values[strings.TrimSuffix(fields[0], ":")] = value
	}
	if values["MemTotal"] == 0 {
		return nil, fmt.Errorf("missing MemTotal")
	}
	if _, ok := values["MemAvailable"]; !ok {
		return nil, fmt.Errorf("missing MemAvailable")
	}
	if values["MemAvailable"] > values["MemTotal"] {
		return nil, fmt.Errorf("invalid MemAvailable")
	}
	return values, nil
}

// SystemInfo samples host CPU and reads Linux memory/load counters. No shell,
// process arguments, arbitrary command execution, or VM changes are involved.
func SystemInfo(params map[string]any) (map[string]any, error) {
	memory, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return nil, err
	}
	mem, err := linuxMemory(string(memory))
	if err != nil {
		return nil, err
	}
	load, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return nil, err
	}
	fields := strings.Fields(string(load))
	if len(fields) < 3 {
		return nil, fmt.Errorf("invalid /proc/loadavg")
	}
	loads := make([]float64, 3)
	for i := range loads {
		loads[i], err = strconv.ParseFloat(fields[i], 64)
		if err != nil {
			return nil, err
		}
	}
	totalBefore, idleBefore, err := linuxCPU()
	if err != nil {
		return nil, err
	}
	time.Sleep(250 * time.Millisecond)
	totalAfter, idleAfter, err := linuxCPU()
	if err != nil {
		return nil, err
	}
	if totalAfter <= totalBefore || idleAfter < idleBefore || idleAfter-idleBefore > totalAfter-totalBefore {
		return nil, fmt.Errorf("CPU counters unavailable; retry")
	}
	hostname, err := os.Hostname()
	if err != nil {
		return nil, err
	}
	const kbPerGiB = 1024 * 1024
	return map[string]any{
		"hostname": hostname, "os": "linux", "arch": runtime.GOARCH,
		"cpu_count": runtime.NumCPU(), "cpu_sample_ms": 250,
		"cpu_usage_pct":   100 * (1 - float64(idleAfter-idleBefore)/float64(totalAfter-totalBefore)),
		"load_average_1m": loads[0], "load_average_5m": loads[1], "load_average_15m": loads[2],
		"total_memory_gb":     float64(mem["MemTotal"]) / kbPerGiB,
		"available_memory_gb": float64(mem["MemAvailable"]) / kbPerGiB,
		"memory_load_pct":     100 * (1 - float64(mem["MemAvailable"])/float64(mem["MemTotal"])),
		"swap_total_gb":       float64(mem["SwapTotal"]) / kbPerGiB,
		"swap_free_gb":        float64(mem["SwapFree"]) / kbPerGiB,
	}, nil
}
