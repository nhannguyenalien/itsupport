//go:build darwin

package tools

import "testing"

// See registry_linux_test.go — same one-directional check (Allowlist ->
// KnownTools), same reasoning: macOS only wires the 9 desktop.* tools by
// design, not the Windows-only IT tools. This one DOES actually run for real
// whenever this package is tested on a Mac (e.g. `go test ./...` on this
// project's own dev machine), unlike registry_windows_test.go in CI.
func TestAllowlistMatchesKnownTools(t *testing.T) {
	for name, def := range Allowlist {
		knownRisk, ok := KnownTools[name]
		if !ok {
			t.Errorf("%q is wired in Allowlist but missing from KnownTools", name)
			continue
		}
		if def.Risk != knownRisk {
			t.Errorf("%q risk mismatch: Allowlist=%q KnownTools=%q", name, def.Risk, knownRisk)
		}
	}
}
