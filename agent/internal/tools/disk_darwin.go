//go:build darwin

package tools

import (
	"fmt"
	"syscall"
)

// DiskUsage reports free/total bytes for a path via statfs(2) — the native
// macOS syscall, same "compiled action, not a shelled-out command" principle
// as disk_windows.go's GetDiskFreeSpaceEx. Defaults to "/" (there's no drive
// letter concept on macOS/APFS); the "drive" param name is kept as-is since
// registry.json shares one param list across every OS this tool runs on.
func DiskUsage(params map[string]any) (map[string]any, error) {
	path := "/"
	if v, ok := params["drive"].(string); ok && v != "" {
		path = v
	}

	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return nil, fmt.Errorf("statfs %q: %w", path, err)
	}

	blockSize := uint64(stat.Bsize)
	totalBytes := stat.Blocks * blockSize
	freeBytes := stat.Bfree * blockSize
	availBytes := stat.Bavail * blockSize

	const gb = 1024 * 1024 * 1024
	return map[string]any{
		"drive":        path,
		"total_gb":     float64(totalBytes) / gb,
		"free_gb":      float64(freeBytes) / gb,
		"available_gb": float64(availBytes) / gb,
		"used_percent": 100 * (1 - float64(freeBytes)/float64(totalBytes)),
	}, nil
}
