//go:build linux

package tools

import (
	"fmt"
	"syscall"
)

// DiskUsage reads filesystem capacity without executing shell commands.
// Reports the requested filesystem only, not LVM pools or VM virtual disks.
func DiskUsage(params map[string]any) (map[string]any, error) {
	path := "/"
	if v, ok := params["drive"].(string); ok && v != "" {
		path = v
	}

	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return nil, fmt.Errorf("statfs %q: %w", path, err)
	}

	if stat.Blocks == 0 {
		return nil, fmt.Errorf("filesystem %q reports zero capacity", path)
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
