package tools

import "testing"

// Computer-use addendum (docs/v0.1-computer-use-addendum.md): every
// desktop.click/move/drag/scroll coordinate is re-validated against the real
// screen bounds before SendInput ever runs (desktop_windows.go's
// clampToVirtualScreen) — this pins down the pure bounds math without needing
// a real Windows box to call GetSystemMetrics.
func TestCoordInBounds(t *testing.T) {
	cases := []struct {
		name                                  string
		x, y, originX, originY, width, height int32
		want                                  bool
	}{
		{"top-left corner, in bounds", 0, 0, 0, 0, 1920, 1080, true},
		{"bottom-right just inside", 1919, 1079, 0, 0, 1920, 1080, true},
		{"bottom-right just outside", 1920, 1080, 0, 0, 1920, 1080, false},
		{"negative coordinate outside", -1, 0, 0, 0, 1920, 1080, false},
		{"multi-monitor negative origin, in bounds", -500, 100, -1920, 0, 3840, 1080, true},
		{"multi-monitor negative origin, out of bounds", -2000, 100, -1920, 0, 3840, 1080, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := coordInBounds(c.x, c.y, c.originX, c.originY, c.width, c.height)
			if got != c.want {
				t.Errorf("coordInBounds(%d,%d, origin=(%d,%d), size=(%d,%d)) = %v, want %v",
					c.x, c.y, c.originX, c.originY, c.width, c.height, got, c.want)
			}
		})
	}
}
