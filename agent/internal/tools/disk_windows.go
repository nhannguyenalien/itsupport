//go:build windows

package tools

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// DiskUsage reports free/total bytes for a drive via GetDiskFreeSpaceEx.
// Defaults to C:\ if no drive param given (most support tickets are about the
// system drive; scenario D in the spec doesn't require picking a drive).
func DiskUsage(params map[string]any) (map[string]any, error) {
	drive := "C:\\"
	if v, ok := params["drive"].(string); ok && v != "" {
		drive = v
		if drive[len(drive)-1] != '\\' {
			drive += "\\"
		}
	}

	drivePtr, err := windows.UTF16PtrFromString(drive)
	if err != nil {
		return nil, fmt.Errorf("invalid drive %q: %w", drive, err)
	}

	var freeBytesAvailable, totalBytes, totalFreeBytes uint64
	if err := windows.GetDiskFreeSpaceEx(drivePtr, &freeBytesAvailable, &totalBytes, &totalFreeBytes); err != nil {
		return nil, fmt.Errorf("get disk free space for %q: %w", drive, err)
	}

	const gb = 1024 * 1024 * 1024
	return map[string]any{
		"drive":        drive,
		"total_gb":     float64(totalBytes) / gb,
		"free_gb":      float64(totalFreeBytes) / gb,
		"available_gb": float64(freeBytesAvailable) / gb,
		"used_percent": 100 * (1 - float64(totalFreeBytes)/float64(totalBytes)),
	}, nil
}
