package tools

// coordInBounds reports whether (x,y) falls within the box
// [originX, originX+width) x [originY, originY+height) — the virtual-screen
// bounds check desktop_windows.go's clampToVirtualScreen applies to every
// coordinate before it ever reaches SendInput (computer-use addendum,
// docs/v0.1-computer-use-addendum.md). Deliberately has NO windows build tag,
// same reasoning as registry.go: the actual bounds come from a Windows-only
// GetSystemMetrics call, but the pure comparison is worth unit-testing
// without a real Windows box.
func coordInBounds(x, y, originX, originY, width, height int32) bool {
	return x >= originX && x < originX+width && y >= originY && y < originY+height
}
