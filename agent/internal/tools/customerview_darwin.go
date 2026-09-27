//go:build darwin

package tools

import (
	"fmt"
	"os/exec"
)

// OpenCustomerView opens the customer's default browser via macOS's `open`
// command — the standard, permission-free way to launch a URL in the
// default browser (no cgo needed, same reasoning as desktop_darwin.go's
// screencapture(1) use).
func OpenCustomerView(params map[string]any) (map[string]any, error) {
	raw, _ := params["url"].(string)
	validated, err := validateCustomerViewURL(raw)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command("open", validated)
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to launch browser: %w", err)
	}
	return map[string]any{"opened": validated}, nil
}
