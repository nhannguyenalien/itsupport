//go:build windows

package tools

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

// disk.space_report — "ổ C đầy": measures a fixed list of locations that
// typically hold reclaimable or user-movable space. Folder totals only, never
// file names. Read-only, bounded by time and file count, does not follow
// junctions/symlinks, and skips cloud placeholders (OneDrive files-on-demand)
// whose logical size is not using local disk.

const (
	spaceReportBudget   = 90 * time.Second
	spaceReportMaxFiles = 3_000_000

	fileAttributeOffline            = 0x00001000
	fileAttributeRecallOnDataAccess = 0x00400000
	fileAttributeRecallOnOpen       = 0x00040000
)

type spaceLocation struct {
	path     string
	category string // what the AI may suggest: cache/temp/update/recycle are cleanable by tools or Windows Settings; user data must be reviewed by the user
	user     string
}

func spaceLocations() []spaceLocation {
	systemDrive := os.Getenv("SystemDrive")
	if systemDrive == "" {
		systemDrive = "C:"
	}
	windowsDir := os.Getenv("SystemRoot")
	if windowsDir == "" {
		windowsDir = systemDrive + `\Windows`
	}
	root := systemDrive + `\`
	locs := []spaceLocation{
		{filepath.Join(root, "$Recycle.Bin"), "recycle_bin", ""},
		{filepath.Join(windowsDir, "SoftwareDistribution", "Download"), "windows_update_cache", ""},
		{filepath.Join(windowsDir, "Temp"), "temp", ""},
		{filepath.Join(root, "Windows.old"), "previous_windows", ""},
		{filepath.Join(windowsDir, "Minidump"), "crash_dumps", ""},
		{filepath.Join(os.Getenv("ProgramData"), "Microsoft", "Windows", "WER"), "crash_dumps", ""},
		{filepath.Join(windowsDir, "Installer"), "system_do_not_delete", ""},
	}
	usersDir := filepath.Join(root, "Users")
	entries, _ := os.ReadDir(usersDir)
	for _, e := range entries {
		name := e.Name()
		if !e.IsDir() || strings.EqualFold(name, "Public") || strings.EqualFold(name, "Default") ||
			strings.EqualFold(name, "Default User") || strings.EqualFold(name, "All Users") {
			continue
		}
		home := filepath.Join(usersDir, name)
		for _, l := range []struct{ rel, category string }{
			{"Downloads", "user_data"}, {"Desktop", "user_data"}, {"Documents", "user_data"},
			{"Videos", "user_data"}, {"Pictures", "user_data"}, {"OneDrive", "user_data_cloud"},
			{`AppData\Local\Temp`, "temp"},
			{`AppData\Local\Google\Chrome\User Data`, "browser_data"},
			{`AppData\Local\Microsoft\Edge\User Data`, "browser_data"},
			{`AppData\Local\Mozilla\Firefox\Profiles`, "browser_data"},
			{`AppData\Local\Microsoft\Teams`, "app_cache"},
			{`AppData\Local\Packages\MSTeams_8wekyb3d8bbwe`, "app_cache"},
			{`AppData\Local\CrashDumps`, "crash_dumps"},
		} {
			locs = append(locs, spaceLocation{filepath.Join(home, l.rel), l.category, name})
		}
	}
	return locs
}

type spaceBudget struct {
	deadline time.Time
	files    int
}

func (b *spaceBudget) exhausted() bool {
	return b.files >= spaceReportMaxFiles || time.Now().After(b.deadline)
}

func measureDir(root string, budget *spaceBudget) (bytes int64, files int, complete bool) {
	complete = true
	filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if budget.exhausted() {
			complete = false
			return fs.SkipAll
		}
		if err != nil {
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.Type()&(fs.ModeSymlink|fs.ModeIrregular) != 0 {
			return nil // junctions/symlinks/mount points: never followed
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		if attrs, ok := info.Sys().(*syscall.Win32FileAttributeData); ok {
			if attrs.FileAttributes&(fileAttributeOffline|fileAttributeRecallOnDataAccess|fileAttributeRecallOnOpen) != 0 {
				return nil
			}
		}
		bytes += info.Size()
		files++
		budget.files++
		return nil
	})
	return bytes, files, complete
}

func fileSizeGB(path string) float64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return round1(float64(info.Size()) / (1 << 30))
}

// DiskSpaceReport lists the measured locations largest first, plus the sizes
// of hibernation/page files, which Windows manages itself.
func DiskSpaceReport(params map[string]any) (map[string]any, error) {
	budget := &spaceBudget{deadline: time.Now().Add(spaceReportBudget)}
	results := make([]map[string]any, 0, 32)
	incomplete := false
	for _, loc := range spaceLocations() {
		if _, err := os.Lstat(loc.path); err != nil {
			continue
		}
		bytes, files, complete := measureDir(loc.path, budget)
		if !complete {
			incomplete = true
		}
		if bytes < 50<<20 { // under 50 MB is noise for a "disk full" ticket
			continue
		}
		item := map[string]any{"path": loc.path, "category": loc.category, "size_gb": round1(float64(bytes) / (1 << 30)), "files": files}
		if loc.user != "" {
			item["user"] = loc.user
		}
		if !complete {
			item["partial"] = true
		}
		results = append(results, item)
		if budget.exhausted() {
			break
		}
	}
	sort.Slice(results, func(i, j int) bool { return results[i]["size_gb"].(float64) > results[j]["size_gb"].(float64) })

	systemDrive := os.Getenv("SystemDrive")
	if systemDrive == "" {
		systemDrive = "C:"
	}
	return map[string]any{
		"locations":       results,
		"hiberfil_gb":     fileSizeGB(systemDrive + `\hiberfil.sys`),
		"pagefile_gb":     fileSizeGB(systemDrive + `\pagefile.sys`),
		"incomplete_scan": incomplete,
		"note":            "Folder totals only. user_data must be reviewed by the user; system_do_not_delete must never be removed manually.",
	}, nil
}
