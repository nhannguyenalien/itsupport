//go:build linux

package tools

import (
	"errors"

	"support-agent/agent/internal/shellrun"
)

// approvedParam is set by the backend on the pending-call response (never
// stored, and refused from the AI/human request), only for a command a human
// approved. See docs/v0.3-linux-shell-addendum.md.
const approvedParam = "__approved"

// ShellRun runs one free-form command after shellrun classifies it. deny never
// runs; write only runs when approved; read runs unattended.
func ShellRun(params map[string]any) (map[string]any, error) {
	raw, ok := params["argv"].([]any)
	if !ok {
		return nil, errors.New("argv must be an array of strings")
	}
	argv := make([]string, len(raw))
	for i, item := range raw {
		s, ok := item.(string)
		if !ok {
			return nil, errors.New("argv must be an array of strings")
		}
		argv[i] = s
	}
	approved, _ := params[approvedParam].(bool)
	return shellrun.Run(argv, approved)
}
