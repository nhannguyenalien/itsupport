//go:build windows

package tools

import "testing"

// The two registries in this package (KnownTools in registry.go, Allowlist in
// registry_windows.go) are hand-kept in sync — the executor refuses anything
// not in BOTH. This test fails the build the moment they drift.
func TestAllowlistMatchesKnownTools(t *testing.T) {
	for name := range KnownTools {
		if _, ok := Allowlist[name]; !ok {
			t.Errorf("%q is in KnownTools but has no Allowlist (implementation) entry", name)
		}
	}
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
