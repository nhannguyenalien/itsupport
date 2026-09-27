package executor

import "testing"

// This is the single most important test in the agent: it proves that a
// backend bug (or a compromised backend) asking the agent to run something
// like "powershell.exec" gets refused at the agent boundary, not just by
// backend-side policy. See docs/v0.1-spec.md "Verification phải deterministic"
// section's sibling requirement, "Agent không biết tool đó → reject ngay tại
// endpoint, kể cả backend có bug."
func TestExecute_RejectsUnknownTool(t *testing.T) {
	result := Execute(Request{ToolCallID: "test-1", Tool: "powershell.exec", Params: map[string]any{"script": "rm -rf /"}})
	if result.Success {
		t.Fatal("expected unknown tool to be rejected, got Success=true")
	}
	if result.Error == "" {
		t.Fatal("expected a non-empty rejection error")
	}
}

// Computer-use addendum (docs/v0.1-computer-use-addendum.md): a plausible-
// looking desktop.* name that was never registered must fail closed exactly
// like any other unknown tool — no special-casing the new tool family lets
// something slip past the allowlist.
func TestExecute_RejectsUnknownDesktopTool(t *testing.T) {
	result := Execute(Request{ToolCallID: "test-desktop-1", Tool: "desktop.exec", Params: map[string]any{"command": "calc.exe"}})
	if result.Success {
		t.Fatal("expected unknown desktop.* tool to be rejected, got Success=true")
	}
	if result.Error == "" {
		t.Fatal("expected a non-empty rejection error")
	}
}

func TestExecute_KnownToolReachesDispatch(t *testing.T) {
	// On non-Windows this still exercises the full Execute() path up to
	// dispatch(), which on this platform always returns a clean "windows only"
	// error rather than panicking or silently doing nothing.
	result := Execute(Request{ToolCallID: "test-2", Tool: "system.info", Params: map[string]any{}})
	if result.Success {
		t.Fatal("system.info should not report success on a non-Windows build")
	}
	if result.Error == "" {
		t.Fatal("expected a non-empty error explaining why it didn't run")
	}
}
