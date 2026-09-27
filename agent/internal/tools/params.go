package tools

import "fmt"

// Deliberately no build tag: these are pure param-validation helpers shared
// by the Windows Win32 tools (service_windows.go) and the desktop.* computer-
// use tools across all three OS builds (desktop_windows.go, desktop_darwin.go,
// desktop_linux.go) — none of this touches an OS API, so it's worth keeping
// as one implementation rather than three copies drifting apart.

func requireStringParam(params map[string]any, key string) (string, error) {
	v, ok := params[key]
	if !ok {
		return "", fmt.Errorf("missing required param %q", key)
	}
	s, ok := v.(string)
	if !ok || s == "" {
		return "", fmt.Errorf("param %q must be a non-empty string", key)
	}
	return s, nil
}

func requireNumberParam(params map[string]any, key string) (float64, error) {
	v, ok := params[key]
	if !ok {
		return 0, fmt.Errorf("missing required param %q", key)
	}
	f, ok := v.(float64) // JSON numbers decode as float64
	if !ok {
		return 0, fmt.Errorf("param %q must be a number", key)
	}
	return f, nil
}

func stringSlice(v any) ([]string, error) {
	arr, ok := v.([]any)
	if !ok {
		return nil, fmt.Errorf("expected an array")
	}
	out := make([]string, 0, len(arr))
	for _, item := range arr {
		s, ok := item.(string)
		if !ok {
			return nil, fmt.Errorf("expected an array of strings")
		}
		out = append(out, s)
	}
	return out, nil
}

// Computer-use addendum (docs/v0.1-computer-use-addendum.md) per-action caps —
// bound the blast radius of any single approved action, same on every OS.
const (
	maxWaitMs       = 5000 // a "wait" action can never hang the executor indefinitely
	maxDragPoints   = 100
	maxKeypressKeys = 5 // a chord (e.g. ctrl+alt+delete), not a macro
	maxTypeTextLen  = 500
)
