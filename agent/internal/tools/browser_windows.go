//go:build windows

package tools

import (
	"fmt"
	"net/url"
	"os/exec"
	"strings"
)

// OpenURL launches the user's default browser at a URL the backend already
// built and signed server-side (see backend/src/oauth/routes.ts, which
// overwrites this param rather than trusting whatever a caller sent). Exists
// so a human on THIS machine can complete an OAuth consent screen using
// whatever platform session their own browser already has — the agent never
// touches login credentials and never automates the "Allow" click itself.
// That's deliberate, not a shortcut not yet taken: auto-clicking through an
// OAuth consent screen violates Google's and Meta's OAuth app policies and
// defeats the point of consent as a security control (see
// docs/v0.2-marketing-ops-spec.md known gaps).
//
// Independently re-checks the URL (scheme + path) instead of trusting the
// backend's word alone — same defense-in-depth principle every other tool
// here follows, re-validating params rather than assuming policy-engine
// approval upstream already made them safe.
func OpenURL(params map[string]any) (map[string]any, error) {
	raw, ok := params["url"].(string)
	if !ok || raw == "" {
		return nil, fmt.Errorf("missing url param")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid url: %w", err)
	}
	if u.Scheme != "https" {
		return nil, fmt.Errorf("refusing to open a non-https url")
	}
	if !strings.HasPrefix(u.Path, "/oauth/") {
		return nil, fmt.Errorf("refusing to open a url outside /oauth/* — this tool is scoped to platform-connect links only")
	}

	// `cmd /c start "" <url>` is the standard way to open the OS-default
	// browser on Windows without hardcoding a specific browser's binary path.
	// The empty "" is the required window-title placeholder — without it,
	// `start` misparses a quoted URL as the title instead of the target.
	cmd := exec.Command("cmd", "/c", "start", "", raw)
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to launch browser: %w", err)
	}
	return map[string]any{"opened": raw}, nil
}
