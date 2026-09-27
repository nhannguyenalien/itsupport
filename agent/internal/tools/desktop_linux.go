//go:build linux

package tools

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"image/png"
	"os"
	"strings"
	"time"

	"github.com/BurntSushi/xgb"
	"github.com/BurntSushi/xgb/xproto"
	"github.com/BurntSushi/xgb/xtest"
)

// desktop.* on Linux — computer-use addendum (docs/v0.1-computer-use-addendum.md).
// SCAFFOLD ONLY, more so than any other tool in this repo: this is written
// directly against the X11 core protocol + XTEST extension docs
// (github.com/BurntSushi/xgb, a pure-Go protocol client — no cgo/Xlib, chosen
// so `GOOS=linux go build` cross-compiles cleanly from this dev machine,
// which is neither Linux nor has an X server). It has NEVER been run against
// a live X server — go build/go vet are the only checks that have ever
// touched this file. Known, accepted simplifications, not fixed here:
//   - X11 only. Wayland compositors generally refuse synthetic input/screen
//     capture from an unprivileged client outright — there is no portable fix,
//     each compositor would need its own portal-API integration.
//   - Screenshot assumes the default screen's visual is 32bpp BGRX (the
//     overwhelmingly common case for a TrueColor/DirectColor X11 desktop) —
//     an unusual depth/byte-order server will decode as garbage, not error.
//   - Keyboard input assumes keysyms 0x20-0x7e equal their ASCII value (true
//     per the X11 keysym spec) and reuses whatever keycode the X server's
//     CURRENT mapping already assigns to that keysym — it does not create a
//     temporary mapping the way tools like xdotool do for characters the
//     active layout doesn't expose on any key, and will honestly error for
//     those rather than silently failing.
//   - No multi-monitor awareness (captures/bounds-checks against the default
//     screen only), same posture as desktop_darwin.go.
func connectX() (*xgb.Conn, *xproto.ScreenInfo, error) {
	if os.Getenv("DISPLAY") == "" {
		return nil, nil, fmt.Errorf("no $DISPLAY set — this looks like a Wayland-only session, which computer-use doesn't support on Linux (see docs/v0.1-computer-use-addendum.md)")
	}
	c, err := xgb.NewConn()
	if err != nil {
		return nil, nil, fmt.Errorf("connect to X server: %w", err)
	}
	if err := xtest.Init(c); err != nil {
		c.Close()
		return nil, nil, fmt.Errorf("XTEST extension unavailable: %w", err)
	}
	screen := xproto.Setup(c).DefaultScreen(c)
	return c, screen, nil
}

func withX(fn func(c *xgb.Conn, screen *xproto.ScreenInfo) (map[string]any, error)) (map[string]any, error) {
	c, screen, err := connectX()
	if err != nil {
		return nil, err
	}
	defer c.Close()
	return fn(c, screen)
}

func clampToScreen(screen *xproto.ScreenInfo, x, y float64) (int16, int16, error) {
	xi, yi := int32(x), int32(y)
	if !coordInBounds(xi, yi, 0, 0, int32(screen.WidthInPixels), int32(screen.HeightInPixels)) {
		return 0, 0, fmt.Errorf("coordinate (%d, %d) is outside the default screen bounds (0,0)-(%d,%d)",
			xi, yi, screen.WidthInPixels, screen.HeightInPixels)
	}
	return int16(xi), int16(yi), nil
}

func fakeMotion(c *xgb.Conn, screen *xproto.ScreenInfo, x, y int16) {
	xtest.FakeInput(c, xproto.MotionNotify, 0, 0, screen.Root, x, y, 0)
}

func fakeButton(c *xgb.Conn, screen *xproto.ScreenInfo, press bool, button byte) {
	eventType := byte(xproto.ButtonPress)
	if !press {
		eventType = xproto.ButtonRelease
	}
	xtest.FakeInput(c, eventType, button, 0, screen.Root, 0, 0, 0)
}

// DesktopScreenshot captures the default screen via X11's core GetImage
// request. Read-risk, auto-executes — also the deterministic verification
// step for every write action below.
func DesktopScreenshot(params map[string]any) (map[string]any, error) {
	return withX(func(c *xgb.Conn, screen *xproto.ScreenInfo) (map[string]any, error) {
		reply, err := xproto.GetImage(
			c, xproto.ImageFormatZPixmap, xproto.Drawable(screen.Root),
			0, 0, screen.WidthInPixels, screen.HeightInPixels,
			0xffffffff,
		).Reply()
		if err != nil {
			return nil, fmt.Errorf("GetImage: %w", err)
		}

		width, height := int(screen.WidthInPixels), int(screen.HeightInPixels)
		img := image.NewRGBA(image.Rect(0, 0, width, height))
		// Assumed BGRX32 — see file header comment.
		for i := 0; i+3 < len(reply.Data) && i/4 < width*height; i += 4 {
			img.Pix[i+0] = reply.Data[i+2] // R
			img.Pix[i+1] = reply.Data[i+1] // G
			img.Pix[i+2] = reply.Data[i+0] // B
			img.Pix[i+3] = 0xFF
		}

		var buf bytes.Buffer
		if err := png.Encode(&buf, img); err != nil {
			return nil, fmt.Errorf("png encode: %w", err)
		}
		return map[string]any{
			"width":        width,
			"height":       height,
			"image_base64": base64.StdEncoding.EncodeToString(buf.Bytes()),
		}, nil
	})
}

// DesktopMove moves the pointer without clicking. Read-risk, auto-executes.
func DesktopMove(params map[string]any) (map[string]any, error) {
	xf, err := requireNumberParam(params, "x")
	if err != nil {
		return nil, err
	}
	yf, err := requireNumberParam(params, "y")
	if err != nil {
		return nil, err
	}
	return withX(func(c *xgb.Conn, screen *xproto.ScreenInfo) (map[string]any, error) {
		x, y, err := clampToScreen(screen, xf, yf)
		if err != nil {
			return nil, err
		}
		fakeMotion(c, screen, x, y)
		return map[string]any{"x": x, "y": y}, nil
	})
}

// DesktopWait sleeps for the requested duration (ms, capped). Read-risk. Pure
// Go, no X connection needed, but kept here alongside its siblings.
func DesktopWait(params map[string]any) (map[string]any, error) {
	ms := 1000.0
	if v, ok := params["ms"]; ok {
		f, ok := v.(float64)
		if !ok {
			return nil, fmt.Errorf("param \"ms\" must be a number")
		}
		ms = f
	}
	if ms < 0 {
		ms = 0
	}
	if ms > maxWaitMs {
		ms = maxWaitMs
	}
	time.Sleep(time.Duration(ms) * time.Millisecond)
	return map[string]any{"waited_ms": ms}, nil
}

func x11Button(button string) (byte, error) {
	switch button {
	case "", "left":
		return 1, nil
	case "wheel":
		return 2, nil // middle button
	case "right":
		return 3, nil
	default:
		// "back"/"forward" map to buttons 8/9 by long-standing X11 convention
		// but aren't universally wired by every input driver — refuse rather
		// than silently doing nothing.
		return 0, fmt.Errorf("button %q is not supported on Linux/X11", button)
	}
}

// DesktopClick moves to (x,y) and clicks the given button. risk:"high" in
// registry.json — only ever dispatched after a human approves this exact
// click.
func DesktopClick(params map[string]any) (map[string]any, error) {
	xf, err := requireNumberParam(params, "x")
	if err != nil {
		return nil, err
	}
	yf, err := requireNumberParam(params, "y")
	if err != nil {
		return nil, err
	}
	buttonName, _ := params["button"].(string)
	button, err := x11Button(buttonName)
	if err != nil {
		return nil, err
	}
	return withX(func(c *xgb.Conn, screen *xproto.ScreenInfo) (map[string]any, error) {
		x, y, err := clampToScreen(screen, xf, yf)
		if err != nil {
			return nil, err
		}
		fakeMotion(c, screen, x, y)
		fakeButton(c, screen, true, button)
		fakeButton(c, screen, false, button)
		return map[string]any{"x": x, "y": y, "button": buttonName}, nil
	})
}

// DesktopDoubleClick clicks the left button twice in quick succession.
func DesktopDoubleClick(params map[string]any) (map[string]any, error) {
	xf, err := requireNumberParam(params, "x")
	if err != nil {
		return nil, err
	}
	yf, err := requireNumberParam(params, "y")
	if err != nil {
		return nil, err
	}
	return withX(func(c *xgb.Conn, screen *xproto.ScreenInfo) (map[string]any, error) {
		x, y, err := clampToScreen(screen, xf, yf)
		if err != nil {
			return nil, err
		}
		fakeMotion(c, screen, x, y)
		for i := 0; i < 2; i++ {
			fakeButton(c, screen, true, 1)
			fakeButton(c, screen, false, 1)
		}
		return map[string]any{"x": x, "y": y}, nil
	})
}

// DesktopDrag holds the left button down through a path of points, then
// releases. risk:"high".
func DesktopDrag(params map[string]any) (map[string]any, error) {
	rawPath, ok := params["path"].([]any)
	if !ok || len(rawPath) < 2 {
		return nil, fmt.Errorf("param \"path\" must be an array of at least 2 {x,y} points")
	}
	if len(rawPath) > maxDragPoints {
		return nil, fmt.Errorf("path has %d points, exceeds the %d-point cap", len(rawPath), maxDragPoints)
	}
	type rawPoint struct{ x, y float64 }
	raw := make([]rawPoint, 0, len(rawPath))
	for _, r := range rawPath {
		m, ok := r.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("each path point must be an object with x,y")
		}
		xf, err := requireNumberParam(m, "x")
		if err != nil {
			return nil, err
		}
		yf, err := requireNumberParam(m, "y")
		if err != nil {
			return nil, err
		}
		raw = append(raw, rawPoint{xf, yf})
	}

	return withX(func(c *xgb.Conn, screen *xproto.ScreenInfo) (map[string]any, error) {
		type point struct{ x, y int16 }
		points := make([]point, 0, len(raw))
		for _, r := range raw {
			x, y, err := clampToScreen(screen, r.x, r.y)
			if err != nil {
				return nil, err
			}
			points = append(points, point{x, y})
		}
		fakeMotion(c, screen, points[0].x, points[0].y)
		fakeButton(c, screen, true, 1)
		for _, p := range points[1:] {
			fakeMotion(c, screen, p.x, p.y)
		}
		fakeButton(c, screen, false, 1)
		return map[string]any{"points": len(points)}, nil
	})
}

// namedKeysyms maps key names to X11 keysym values (X11/keysymdef.h — stable
// protocol constants, not tied to any particular server's current keycode
// assignment; resolved to an actual keycode at call time via the server's
// live keyboard mapping, see keysymToKeycode).
var namedKeysyms = map[string]xproto.Keysym{
	"ctrl": 0xffe3, "control": 0xffe3, "lcontrol": 0xffe3, "rcontrol": 0xffe4,
	"alt": 0xffe9, "lalt": 0xffe9, "ralt": 0xffea,
	"shift": 0xffe1, "lshift": 0xffe1, "rshift": 0xffe2,
	"win": 0xffeb, "cmd": 0xffeb, "meta": 0xffe7, "super": 0xffeb,
	"enter": 0xff0d, "return": 0xff0d,
	"tab": 0xff09, "esc": 0xff1b, "escape": 0xff1b,
	"backspace": 0xff08, "delete": 0xffff, "del": 0xffff,
	"space": 0x0020,
	"up":    0xff52, "down": 0xff54, "left": 0xff51, "right": 0xff53,
	"home": 0xff50, "end": 0xff57, "pageup": 0xff55, "pagedown": 0xff56,
	"f1": 0xffbe, "f2": 0xffbf, "f3": 0xffc0, "f4": 0xffc1, "f5": 0xffc2, "f6": 0xffc3,
	"f7": 0xffc4, "f8": 0xffc5, "f9": 0xffc6, "f10": 0xffc7, "f11": 0xffc8, "f12": 0xffc9,
}

func keysymFor(name string) (xproto.Keysym, error) {
	n := strings.ToLower(strings.TrimSpace(name))
	if ks, ok := namedKeysyms[n]; ok {
		return ks, nil
	}
	if len(n) == 1 && n[0] >= 0x20 && n[0] <= 0x7e {
		// X11 keysyms 0x20-0x7e are defined to equal their ASCII value.
		return xproto.Keysym(n[0]), nil
	}
	return 0, fmt.Errorf("key %q is not in the allowlist — refusing to guess a keysym", name)
}

// keysymToKeycode queries the X server's CURRENT keyboard mapping and finds a
// keycode whose primary (unshifted) keysym matches. Returns an error if no
// key on this keyboard currently produces that keysym — this build does not
// attempt to remap the keyboard the way xdotool does for unmapped characters.
func keysymToKeycode(c *xgb.Conn, setup *xproto.SetupInfo, ks xproto.Keysym) (xproto.Keycode, error) {
	count := byte(int(setup.MaxKeycode) - int(setup.MinKeycode) + 1)
	reply, err := xproto.GetKeyboardMapping(c, setup.MinKeycode, count).Reply()
	if err != nil {
		return 0, fmt.Errorf("GetKeyboardMapping: %w", err)
	}
	perKeycode := int(reply.KeysymsPerKeycode)
	if perKeycode == 0 {
		return 0, fmt.Errorf("server reported 0 keysyms per keycode")
	}
	for i := 0; i*perKeycode < len(reply.Keysyms); i++ {
		if reply.Keysyms[i*perKeycode] == ks {
			return xproto.Keycode(int(setup.MinKeycode) + i), nil
		}
	}
	return 0, fmt.Errorf("no keycode on this keyboard currently maps to keysym 0x%x", ks)
}

func fakeKey(c *xgb.Conn, screen *xproto.ScreenInfo, keycode xproto.Keycode, press bool) {
	eventType := byte(xproto.KeyPress)
	if !press {
		eventType = xproto.KeyRelease
	}
	xtest.FakeInput(c, eventType, byte(keycode), 0, screen.Root, 0, 0, 0)
}

// DesktopKeypress presses (and releases, in reverse order) a chord of named
// keys. risk:"high".
func DesktopKeypress(params map[string]any) (map[string]any, error) {
	rawKeys, ok := params["keys"]
	if !ok {
		return nil, fmt.Errorf("missing required param \"keys\"")
	}
	keys, err := stringSlice(rawKeys)
	if err != nil {
		return nil, fmt.Errorf("param \"keys\": %w", err)
	}
	if len(keys) == 0 {
		return nil, fmt.Errorf("param \"keys\" must not be empty")
	}
	if len(keys) > maxKeypressKeys {
		return nil, fmt.Errorf("%d keys exceeds the %d-key chord cap", len(keys), maxKeypressKeys)
	}
	return withX(func(c *xgb.Conn, screen *xproto.ScreenInfo) (map[string]any, error) {
		setup := xproto.Setup(c)
		codes := make([]xproto.Keycode, 0, len(keys))
		for _, k := range keys {
			ks, err := keysymFor(k)
			if err != nil {
				return nil, err
			}
			code, err := keysymToKeycode(c, setup, ks)
			if err != nil {
				return nil, err
			}
			codes = append(codes, code)
		}
		for _, code := range codes {
			fakeKey(c, screen, code, true)
		}
		for i := len(codes) - 1; i >= 0; i-- {
			fakeKey(c, screen, codes[i], false)
		}
		return map[string]any{"keys": keys}, nil
	})
}

// DesktopType sends text one keysym at a time via the server's current
// keyboard mapping — see the keysymToKeycode/file-header caveats about
// characters not present on the active layout. risk:"high", length-capped.
func DesktopType(params map[string]any) (map[string]any, error) {
	text, err := requireStringParam(params, "text")
	if err != nil {
		return nil, err
	}
	runes := []rune(text)
	if len(runes) > maxTypeTextLen {
		return nil, fmt.Errorf("text is %d characters, exceeds the %d-character cap per action", len(runes), maxTypeTextLen)
	}
	return withX(func(c *xgb.Conn, screen *xproto.ScreenInfo) (map[string]any, error) {
		setup := xproto.Setup(c)
		for _, r := range runes {
			if r < 0x20 || r > 0x7e {
				return nil, fmt.Errorf("character %q is outside the supported ASCII range for this build's keysym mapping", r)
			}
			code, err := keysymToKeycode(c, setup, xproto.Keysym(r))
			if err != nil {
				return nil, fmt.Errorf("character %q: %w", r, err)
			}
			fakeKey(c, screen, code, true)
			fakeKey(c, screen, code, false)
		}
		return map[string]any{"characters": len(runes)}, nil
	})
}

// DesktopScroll emulates a wheel event as repeated button4/5 (vertical) or
// button6/7 (horizontal) clicks — the long-standing X11 convention, though
// not every input driver wires buttons 6/7. scroll_x/scroll_y are taken as a
// click count, matching OpenAI's action shape rather than pixel distance.
func DesktopScroll(params map[string]any) (map[string]any, error) {
	xf, err := requireNumberParam(params, "x")
	if err != nil {
		return nil, err
	}
	yf, err := requireNumberParam(params, "y")
	if err != nil {
		return nil, err
	}
	scrollY, _ := params["scroll_y"].(float64)
	scrollX, _ := params["scroll_x"].(float64)

	return withX(func(c *xgb.Conn, screen *xproto.ScreenInfo) (map[string]any, error) {
		x, y, err := clampToScreen(screen, xf, yf)
		if err != nil {
			return nil, err
		}
		fakeMotion(c, screen, x, y)

		scrollOnce := func(down bool, positive byte, negative byte, amount float64) {
			button := positive
			if amount < 0 {
				button = negative
				amount = -amount
			}
			const maxClicks = 20 // bounded — this is a scroll, not an infinite loop
			clicks := int(amount)
			if clicks > maxClicks {
				clicks = maxClicks
			}
			for i := 0; i < clicks; i++ {
				fakeButton(c, screen, true, button)
				fakeButton(c, screen, false, button)
			}
		}
		if scrollY != 0 {
			scrollOnce(true, 4, 5, scrollY)
		}
		if scrollX != 0 {
			scrollOnce(false, 6, 7, scrollX)
		}
		return map[string]any{"scrolled": scrollY != 0 || scrollX != 0}, nil
	})
}
