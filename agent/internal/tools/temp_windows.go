//go:build windows

package tools

import (
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// temp.scan / temp.clean — scenario D ("disk.usage -> temp.scan -> show
// reclaimable -> [approval] -> temp.clean -> disk.usage -> resolved").
//
// Scope is deliberately narrow and fixed at compile time: only the well-known
// scratch locations below, never anything under a user profile's
// Documents/Desktop/Downloads. There is no caller-supplied path parameter —
// "clean temp" must not become "delete an arbitrary directory".

func tempDirs() []string {
	seen := map[string]struct{}{}
	add := func(p string) {
		if p == "" {
			return
		}
		if _, dup := seen[p]; dup {
			return
		}
		seen[p] = struct{}{}
	}
	add(os.Getenv("TEMP"))
	add(os.Getenv("TMP"))
	if w := os.Getenv("SystemRoot"); w != "" {
		add(filepath.Join(w, "Temp"))
	} else {
		add(`C:\Windows\Temp`)
	}

	out := make([]string, 0, len(seen))
	for p := range seen {
		out = append(out, p)
	}
	return out
}

// walkFiles calls fn for every regular file under root, swallowing per-entry
// errors (locked files, denied ACLs) so a partial result is still returned
// rather than aborting the whole scan/clean.
func walkFiles(root string, fn func(path string, info fs.FileInfo)) {
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

// TempScan reports how much space the temp directories are holding — the
// number shown to the approver before temp.clean runs.
func TempScan(params map[string]any) (map[string]any, error) {
	const mb = 1024 * 1024
	var totalBytes, totalFiles int64
	perDir := make([]map[string]any, 0, 4)

	for _, dir := range tempDirs() {
		if _, err := os.Stat(dir); err != nil {
			continue // not present on this host — not an error
		}
		var dirBytes, dirFiles int64
		walkFiles(dir, func(_ string, info fs.FileInfo) {
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

// TempClean deletes files from the temp directories. Write action (risk
// "low"); verification chain is a follow-up disk.usage (registry.json).
// Files modified within the last hour are left alone — they're the ones most
// likely to belong to a running installer or process. Directories are never
// removed, only their contents.
func TempClean(params map[string]any) (map[string]any, error) {
	const mb = 1024 * 1024
	cutoff := time.Now().Add(-1 * time.Hour)
	var freedBytes, deletedFiles, skipped int64

	for _, dir := range tempDirs() {
		if _, err := os.Stat(dir); err != nil {
			continue
		}
		walkFiles(dir, func(path string, info fs.FileInfo) {
			if info.ModTime().After(cutoff) {
				skipped++
				return
			}
			size := info.Size()
			if err := os.Remove(path); err != nil {
				skipped++
				return
			}
			freedBytes += size
			deletedFiles++
		})
	}

	return map[string]any{
		"freed_bytes":   freedBytes,
		"freed_mb":      float64(freedBytes) / mb,
		"deleted_files": deletedFiles,
		"skipped":       skipped,
	}, nil
}
