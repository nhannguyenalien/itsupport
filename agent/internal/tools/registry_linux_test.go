//go:build linux

package tools

import "testing"

// Unlike registry_windows_test.go (which CI only ever cross-compiles via
// GOOS=windows, never executes — the CI agent job runs on ubuntu-latest),
// this one actually RUNS in CI, since ubuntu-latest IS linux. One-directional
// only (Allowlist -> KnownTools, not the reverse): Linux only wires the 9
// desktop.* tools by design, so most of KnownTools (the Windows-only IT
// tools) has no Linux Allowlist entry — that's expected, not a drift bug.
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
