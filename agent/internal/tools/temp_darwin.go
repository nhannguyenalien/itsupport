//go:build darwin

package tools

import (
	"io/fs"
	"os"
	"path/filepath"
)

// temp.scan (macOS) — same scope/reasoning as temp_windows.go: a fixed,
// compile-time list of scratch locations, never a caller-supplied path. Only
// the read side (temp.scan) is ported here — temp.clean (the write/delete
// counterpart) is out of scope for this pass and stays Windows-only.
//
// Self-contained rather than sharing temp_windows.go's tempDirs()/walkFiles()
// helpers: those are windows-only (build-tagged) and the only genuinely
// OS-specific piece is the directory list — duplicating ~40 lines here was
// judged simpler than extracting a shared file for logic this small,
// especially since TempClean (which WOULD justify sharing more) isn't being
// ported in this pass.

func tempDirsDarwin() []string {
	seen := map[string]struct{}{}
	var out []string
	add := func(p string) {
		if p == "" {
			return
		}
		if _, dup := seen[p]; dup {
			return
		}
		seen[p] = struct{}{}
		out = append(out, p)
	}
	add(os.Getenv("TMPDIR")) // macOS sets this per-user, e.g. /var/folders/.../T/
	add("/tmp")
	return out
}

func walkFilesDarwin(root string, fn func(path string, info fs.FileInfo)) {
	filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil || !info.Mode().IsRegular() {
			return nil
		}
		fn(path, info)
		return nil
	})
}

// TempScan reports how much space the temp directories are holding.
func TempScan(params map[string]any) (map[string]any, error) {
	const mb = 1024 * 1024
	var totalBytes, totalFiles int64
	perDir := make([]map[string]any, 0, 4)

	for _, dir := range tempDirsDarwin() {
		if _, err := os.Stat(dir); err != nil {
			continue // not present — not an error
		}
		var dirBytes, dirFiles int64
		walkFilesDarwin(dir, func(_ string, info fs.FileInfo) {
			dirBytes += info.Size()
			dirFiles++
		})
		totalBytes += dirBytes
		totalFiles += dirFiles
		perDir = append(perDir, map[string]any{
			"path":    dir,
			"bytes":   dirBytes,
			"files":   dirFiles,
			"size_mb": float64(dirBytes) / mb,
		})
	}

	return map[string]any{
		"reclaimable_bytes": totalBytes,
		"reclaimable_mb":    float64(totalBytes) / mb,
		"file_count":        totalFiles,
		"directories":       perDir,
	}, nil
}
