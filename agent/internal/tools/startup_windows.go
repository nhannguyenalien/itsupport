//go:build windows

package tools

import (
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// startup.list / startup.disable / startup.enable — "máy khởi động chậm, quá
// nhiều app chạy cùng Windows". Disabling works exactly like Task Manager's
// Startup tab: it flips the entry's StartupApproved flag and never deletes the
// Run value or the shortcut, so startup.enable fully reverts it.
//
// Callers identify an entry only by the opaque id returned from
// startup.list; the id is re-resolved against a fresh enumeration, so no
// caller-supplied registry path or file path is ever written to.

const (
	runKeyPath      = `Software\Microsoft\Windows\CurrentVersion\Run`
	run32KeyPath    = `Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run`
	approvedKeyBase = `Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\`
	maxCommandChars = 260
)

type startupEntry struct {
	ID       string
	Name     string
	Scope    string // "machine" or the user's SID
	User     string
	Kind     string // Run | Run32 | StartupFolder
	Command  string
	root     registry.Key
	approved string // StartupApproved subkey path under root
}

func userHiveSIDs() []string {
	k, err := registry.OpenKey(registry.USERS, "", registry.ENUMERATE_SUB_KEYS)
	if err != nil {
		return nil
	}
	defer k.Close()
	names, _ := k.ReadSubKeyNames(-1)
	out := make([]string, 0, len(names))
	for _, n := range names {
		// Real interactive/domain users only; skip *_Classes and service SIDs.
		if strings.HasPrefix(n, "S-1-5-21-") && !strings.HasSuffix(n, "_Classes") {
			out = append(out, n)
		}
	}
	return out
}

func accountName(sid string) string {
	s, err := windows.StringToSid(sid)
	if err != nil {
		return sid
	}
	account, domain, _, err := s.LookupAccount("")
	if err != nil {
		return sid
	}
	return domain + `\` + account
}

func profilePath(sid string) string {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\`+sid, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	p, _, err := k.GetStringValue("ProfileImagePath")
	if err != nil {
		return ""
	}
	expanded, err := registry.ExpandString(p)
	if err != nil {
		return p
	}
	return expanded
}

func truncateCommand(s string) string {
	if len(s) > maxCommandChars {
		return s[:maxCommandChars] + "…"
	}
	return s
}

func readRunKey(root registry.Key, path, scope, user, kind, approvedSub string, out *[]startupEntry) {
	k, err := registry.OpenKey(root, path, registry.QUERY_VALUE)
	if err != nil {
		return
	}
	defer k.Close()
	names, _ := k.ReadValueNames(-1)
	for _, name := range names {
		if name == "" {
			continue
		}
		command, _, err := k.GetStringValue(name)
		if err != nil {
			continue
		}
		*out = append(*out, startupEntry{
			ID: scope + "|" + kind + "|" + name, Name: name, Scope: scope, User: user, Kind: kind,
			Command: truncateCommand(command), root: root, approved: approvedKeyBase + approvedSub,
		})
	}
}

func readStartupFolder(dir string, root registry.Key, approvedPrefix, scope, user string, out *[]startupEntry) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() || strings.EqualFold(e.Name(), "desktop.ini") {
			continue
		}
		*out = append(*out, startupEntry{
			ID: scope + "|StartupFolder|" + e.Name(), Name: e.Name(), Scope: scope, User: user, Kind: "StartupFolder",
			Command: truncateCommand(filepath.Join(dir, e.Name())), root: root, approved: approvedPrefix + "StartupFolder",
		})
	}
}

func enumerateStartup() []startupEntry {
	var out []startupEntry
	readRunKey(registry.LOCAL_MACHINE, runKeyPath, "machine", "", "Run", "Run", &out)
	readRunKey(registry.LOCAL_MACHINE, run32KeyPath, "machine", "", "Run32", "Run32", &out)
	if programData := os.Getenv("ProgramData"); programData != "" {
		readStartupFolder(filepath.Join(programData, `Microsoft\Windows\Start Menu\Programs\StartUp`),
			registry.LOCAL_MACHINE, approvedKeyBase, "machine", "", &out)
	}
	for _, sid := range userHiveSIDs() {
		user := accountName(sid)
		readRunKey(registry.USERS, sid+`\`+runKeyPath, sid, user, "Run", "Run", &out)
		if profile := profilePath(sid); profile != "" {
			readStartupFolder(filepath.Join(profile, `AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup`),
				registry.USERS, sid+`\`+approvedKeyBase, sid, user, &out)
		}
	}
	// User-scope entries carry the SID prefix in their approved path already.
	for i := range out {
		if out[i].Scope != "machine" && out[i].Kind != "StartupFolder" {
			out[i].approved = out[i].Scope + `\` + out[i].approved
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// startupEnabled: a missing StartupApproved value means enabled; otherwise
// an odd first byte (0x03, 0x07…) means disabled, as Task Manager writes it.
func startupEnabled(e startupEntry) bool {
	k, err := registry.OpenKey(e.root, e.approved, registry.QUERY_VALUE)
	if err != nil {
		return true
	}
	defer k.Close()
	data, _, err := k.GetBinaryValue(e.Name)
	if err != nil || len(data) == 0 {
		return true
	}
	return data[0]&1 == 0
}

// StartupList returns every startup entry with its enabled state.
func StartupList(params map[string]any) (map[string]any, error) {
	entries := enumerateStartup()
	list := make([]map[string]any, 0, len(entries))
	enabled := 0
	for _, e := range entries {
		on := startupEnabled(e)
		if on {
			enabled++
		}
		item := map[string]any{"id": e.ID, "name": e.Name, "kind": e.Kind, "scope": "machine", "enabled": on, "command": e.Command}
		if e.Scope != "machine" {
			item["scope"] = "user"
			item["user"] = e.User
		}
		list = append(list, item)
	}
	return map[string]any{"entries": list, "count": len(list), "enabled_count": enabled}, nil
}

func findStartupEntry(params map[string]any) (startupEntry, error) {
	id, err := requireStringParam(params, "entry_id")
	if err != nil {
		return startupEntry{}, err
	}
	for _, e := range enumerateStartup() {
		if e.ID == id {
			return e, nil
		}
	}
	return startupEntry{}, fmt.Errorf("startup entry %q not found; call startup.list for current ids", id)
}

func setStartupApproved(e startupEntry, enable bool) error {
	k, _, err := registry.CreateKey(e.root, e.approved, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("open StartupApproved for %q: %w", e.Name, err)
	}
	defer k.Close()
	data := make([]byte, 12)
	if enable {
		data[0] = 0x02
	} else {
		data[0] = 0x03
		ft := windows.NsecToFiletime(time.Now().UnixNano())
		binary.LittleEndian.PutUint32(data[4:], ft.LowDateTime)
		binary.LittleEndian.PutUint32(data[8:], ft.HighDateTime)
	}
	if err := k.SetBinaryValue(e.Name, data); err != nil {
		return fmt.Errorf("update StartupApproved for %q: %w", e.Name, err)
	}
	return nil
}

func toggleStartup(params map[string]any, enable bool) (map[string]any, error) {
	e, err := findStartupEntry(params)
	if err != nil {
		return nil, err
	}
	if err := setStartupApproved(e, enable); err != nil {
		return nil, err
	}
	if startupEnabled(e) != enable {
		return nil, fmt.Errorf("startup entry %q did not change state", e.Name)
	}
	return map[string]any{"entry_id": e.ID, "name": e.Name, "enabled": enable, "takes_effect": "next sign-in"}, nil
}

// StartupDisable turns one startup entry off (reversible). Risk "low".
func StartupDisable(params map[string]any) (map[string]any, error) {
	return toggleStartup(params, false)
}

// StartupEnable turns a previously disabled startup entry back on. Risk "low".
func StartupEnable(params map[string]any) (map[string]any, error) {
	return toggleStartup(params, true)
}
