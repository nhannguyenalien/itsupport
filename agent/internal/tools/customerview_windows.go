//go:build windows

package tools

import (
	"fmt"
	"os/exec"
)

// OpenCustomerView opens the customer's default browser — same technique as
// browser_windows.go's OpenURL (`cmd /c start "" <url>` is the standard way
// to launch the OS-default browser on Windows; the empty "" is the required
// window-title placeholder, without it `start` misparses a quoted URL as the
// title instead of the target).
func OpenCustomerView(params map[string]any) (map[string]any, error) {
	raw, _ := params["url"].(string)
	validated, err := validateCustomerViewURL(raw)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command("cmd", "/c", "start", "", validated)
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to launch browser: %w", err)
	}
	return map[string]any{"opened": validated}, nil
}
