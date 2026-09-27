//go:build linux

package tools

import (
	"fmt"
	"os/exec"
)

// OpenCustomerView opens the customer's default browser via `xdg-open` — the
// standard freedesktop.org way to launch a URL in whatever the desktop
// environment has configured as the default browser. Requires xdg-utils to
// be installed (present on virtually every desktop Linux distribution, but
// genuinely absent on a minimal/headless install) — fails with a clear error
// rather than a silent no-op if it's missing.
func OpenCustomerView(params map[string]any) (map[string]any, error) {
	raw, _ := params["url"].(string)
	validated, err := validateCustomerViewURL(raw)
	if err != nil {
		return nil, err
	}
	if _, err := exec.LookPath("xdg-open"); err != nil {
		return nil, fmt.Errorf("xdg-open not found — is this a desktop Linux install? (%w)", err)
	}
	cmd := exec.Command("xdg-open", validated)
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to launch browser: %w", err)
	}
	return map[string]any{"opened": validated}, nil
}
