//go:build darwin

package tools

/*
#cgo LDFLAGS: -framework ApplicationServices -framework CoreGraphics -framework CoreFoundation
#include <ApplicationServices/ApplicationServices.h>

// Small static C helpers wrapping the Quartz Event Services calls this file
// needs — cgo can't call CGEventCreateScrollWheelEvent's variadic tail
// directly from Go, and wrapping the create+post+release triple here keeps
// every Go-side call a single, simple function call.

static void postMouseEvent(CGEventType type, CGMouseButton button, double x, double y) {
	CGPoint point = CGPointMake(x, y);
	CGEventRef event = CGEventCreateMouseEvent(NULL, type, point, button);
	if (event) {
		CGEventPost(kCGHIDEventTap, event);
		CFRelease(event);
	}
}

static void postKeyEvent(CGKeyCode key, int keyDown) {
	CGEventRef event = CGEventCreateKeyboardEvent(NULL, key, keyDown != 0);
	if (event) {
		CGEventPost(kCGHIDEventTap, event);
		CFRelease(event);
	}
}

static void postUnicodeKeyEvent(UniChar ch, int keyDown) {
	CGEventRef event = CGEventCreateKeyboardEvent(NULL, 0, keyDown != 0);
	if (event) {
		CGEventKeyboardSetUnicodeString(event, 1, &ch);
		CGEventPost(kCGHIDEventTap, event);
		CFRelease(event);
	}
}

static void postScrollEvent(int32_t scrollY, int32_t scrollX) {
	CGEventRef event = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 2, scrollY, scrollX);
	if (event) {
		CGEventPost(kCGHIDEventTap, event);
		CFRelease(event);
	}
}

static CGRect mainDisplayBoundsC() {
	return CGDisplayBounds(CGMainDisplayID());
}
*/
import "C"

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	_ "image/png"
	"os"
	"os/exec"
	"strings"
	"time"
)

// desktop.* on macOS — computer-use addendum (docs/v0.1-computer-use-addendum.md).
// Real implementation (unlike desktop_linux.go's scaffold): DesktopScreenshot
// shells out to the OS's own screencapture(1) (no cgo, no third-party tool —
// same "don't reimplement what the platform already provides correctly"
// reasoning as everywhere else in this repo); every input-injection tool uses
// cgo bindings to Quartz Event Services (CGEventPost) above.
//
// KNOWN GAP, documented not hidden: bounds-checking only considers the MAIN
// display (mainDisplayBoundsC/CGDisplayBounds(CGMainDisplayID())), unlike the
// Windows implementation which unions every monitor via
// SM_CXVIRTUALSCREEN/SM_CYVIRTUALSCREEN — a click/type targeting a secondary
// display on a multi-monitor Mac will be rejected as out-of-bounds today.
// DesktopKeypress additionally assumes a US ANSI keyboard layout (macOS
// virtual keycodes are position-based, not character-based, and mapping the
// CURRENT layout correctly needs TISCopyCurrentKeyboardLayoutInputSource +
// UCKeyTranslate, not done here) — DesktopType (Unicode-based) has no such
// limitation and is the safer choice for arbitrary text.

func mainDisplayBounds() (originX, originY, width, height int32) {
	r := C.mainDisplayBoundsC()
	return int32(r.origin.x), int32(r.origin.y), int32(r.size.width), int32(r.size.height)
}

func clampToVirtualScreen(x, y float64) (int32, int32, error) {
	originX, originY, width, height := mainDisplayBounds()
	xi, yi := int32(x), int32(y)
	if !coordInBounds(xi, yi, originX, originY, width, height) {
		return 0, 0, fmt.Errorf("coordinate (%d, %d) is outside the main display bounds (%d,%d)-(%d,%d) — secondary displays aren't supported yet",
			xi, yi, originX, originY, originX+width, originY+height)
	}
	return xi, yi, nil
}

// DesktopScreenshot captures the whole screen via screencapture(1) into a
// temp file, reads it back as PNG, and removes the file. Read-risk,
// auto-executes — also the deterministic verification step for every write
// action below.
func DesktopScreenshot(params map[string]any) (map[string]any, error) {
	tmp, err := os.CreateTemp("", "support-agent-screenshot-*.png")
	if err != nil {
		return nil, fmt.Errorf("create temp file: %w", err)
	}
	path := tmp.Name()
	tmp.Close()
	defer os.Remove(path)

	// -x: no camera shutter sound. -C: include cursor (helps the model see
	// where the pointer currently is).
	cmd := exec.Command("/usr/sbin/screencapture", "-x", "-C", path)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("screencapture failed: %w (%s)", err, strings.TrimSpace(stderr.String()))
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read captured screenshot: %w", err)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("captured file is not a valid image: %w", err)
	}

	return map[string]any{
		"width":        cfg.Width,
		"height":       cfg.Height,
		"image_base64": base64.StdEncoding.EncodeToString(data),
	}, nil
}

// DesktopMove moves the cursor without clicking. Read-risk, auto-executes.
func DesktopMove(params map[string]any) (map[string]any, error) {
	xf, err := requireNumberParam(params, "x")
	if err != nil {
		return nil, err
	}
	yf, err := requireNumberParam(params, "y")
	if err != nil {
		return nil, err
	}
	x, y, err := clampToVirtualScreen(xf, yf)
	if err != nil {
		return nil, err
	}
	C.postMouseEvent(C.kCGEventMouseMoved, C.kCGMouseButtonLeft, C.double(x), C.double(y))
	return map[string]any{"x": x, "y": y}, nil
}

// DesktopWait sleeps for the requested duration (ms, capped). Read-risk.
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

func mouseEventPair(button string) (down, up C.CGEventType, cgButton C.CGMouseButton, err error) {
	switch button {
	case "", "left":
		return C.kCGEventLeftMouseDown, C.kCGEventLeftMouseUp, C.kCGMouseButtonLeft, nil
	case "right":
		return C.kCGEventRightMouseDown, C.kCGEventRightMouseUp, C.kCGMouseButtonRight, nil
	case "wheel":
		return C.kCGEventOtherMouseDown, C.kCGEventOtherMouseUp, C.kCGMouseButtonCenter, nil
	default:
		// "back"/"forward" (mouse side buttons) aren't a first-class Quartz
		// mouse-button concept the way they are on Windows — refuse rather
		// than guess a button index that might not mean what it should.
		return 0, 0, 0, fmt.Errorf("button %q is not supported on macOS", button)
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
	x, y, err := clampToVirtualScreen(xf, yf)
	if err != nil {
		return nil, err
	}
	button, _ := params["button"].(string)
	down, up, cgButton, err := mouseEventPair(button)
	if err != nil {
		return nil, err
	}
	C.postMouseEvent(C.kCGEventMouseMoved, C.kCGMouseButtonLeft, C.double(x), C.double(y))
	C.postMouseEvent(down, cgButton, C.double(x), C.double(y))
	C.postMouseEvent(up, cgButton, C.double(x), C.double(y))
	return map[string]any{"x": x, "y": y, "button": button}, nil
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
	x, y, err := clampToVirtualScreen(xf, yf)
	if err != nil {
		return nil, err
	}
	C.postMouseEvent(C.kCGEventMouseMoved, C.kCGMouseButtonLeft, C.double(x), C.double(y))
	for i := 0; i < 2; i++ {
		C.postMouseEvent(C.kCGEventLeftMouseDown, C.kCGMouseButtonLeft, C.double(x), C.double(y))
		C.postMouseEvent(C.kCGEventLeftMouseUp, C.kCGMouseButtonLeft, C.double(x), C.double(y))
	}
	return map[string]any{"x": x, "y": y}, nil
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
	type point struct{ x, y int32 }
	points := make([]point, 0, len(rawPath))
	for _, raw := range rawPath {
		m, ok := raw.(map[string]any)
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
		x, y, err := clampToVirtualScreen(xf, yf)
		if err != nil {
			return nil, err
		}
		points = append(points, point{x, y})
	}

	C.postMouseEvent(C.kCGEventMouseMoved, C.kCGMouseButtonLeft, C.double(points[0].x), C.double(points[0].y))
	C.postMouseEvent(C.kCGEventLeftMouseDown, C.kCGMouseButtonLeft, C.double(points[0].x), C.double(points[0].y))
	for _, p := range points[1:] {
		C.postMouseEvent(C.kCGEventLeftMouseDragged, C.kCGMouseButtonLeft, C.double(p.x), C.double(p.y))
	}
	last := points[len(points)-1]
	C.postMouseEvent(C.kCGEventLeftMouseUp, C.kCGMouseButtonLeft, C.double(last.x), C.double(last.y))

	return map[string]any{"points": len(points)}, nil
}

// namedVirtualKeys maps key names to macOS virtual keycodes (Carbon
// HIToolbox constants — stable across macOS versions, position-based on a US
// ANSI keyboard). Same "unrecognized name fails closed" principle as the
// Windows allowlist and the tool-name allowlist itself.
var namedVirtualKeys = map[string]C.CGKeyCode{
	"a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07,
	"c": 0x08, "v": 0x09, "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10,
	"t": 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17, "9": 0x19,
	"7": 0x1A, "8": 0x1C, "0": 0x1D, "o": 0x1F, "u": 0x20, "i": 0x22, "p": 0x23,
	"l": 0x25, "j": 0x26, "k": 0x28, "n": 0x2D, "m": 0x2E,

	"ctrl": 0x3B, "control": 0x3B, "lcontrol": 0x3B, "rcontrol": 0x3E,
	"alt": 0x3A, "option": 0x3A, "lalt": 0x3A, "ralt": 0x3D,
	"shift": 0x38, "lshift": 0x38, "rshift": 0x3C,
	"win": 0x37, "cmd": 0x37, "meta": 0x37, "super": 0x37, "command": 0x37,
	"enter": 0x24, "return": 0x24,
	"tab": 0x30, "esc": 0x35, "escape": 0x35,
	"backspace": 0x33, "delete": 0x75, "del": 0x75,
	"space": 0x31,
	"up":    0x7E, "down": 0x7D, "left": 0x7B, "right": 0x7C,
	"home": 0x73, "end": 0x77, "pageup": 0x74, "pagedown": 0x79,
	"f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76, "f5": 0x60, "f6": 0x61,
	"f7": 0x62, "f8": 0x64, "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
}

func virtualKeyFor(name string) (C.CGKeyCode, error) {
	n := strings.ToLower(strings.TrimSpace(name))
	if vk, ok := namedVirtualKeys[n]; ok {
		return vk, nil
	}
	return 0, fmt.Errorf("key %q is not in the allowlist — refusing to guess a virtual keycode", name)
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
	vks := make([]C.CGKeyCode, 0, len(keys))
	for _, k := range keys {
		vk, err := virtualKeyFor(k)
		if err != nil {
			return nil, err
		}
		vks = append(vks, vk)
	}
	for _, vk := range vks {
		C.postKeyEvent(vk, 1)
	}
	for i := len(vks) - 1; i >= 0; i-- {
		C.postKeyEvent(vks[i], 0)
	}
	return map[string]any{"keys": keys}, nil
}

// DesktopType posts arbitrary Unicode text directly via
// CGEventKeyboardSetUnicodeString — layout-independent, unlike DesktopKeypress.
// risk:"high", length-capped.
func DesktopType(params map[string]any) (map[string]any, error) {
	text, err := requireStringParam(params, "text")
	if err != nil {
		return nil, err
	}
	runes := []rune(text)
	if len(runes) > maxTypeTextLen {
		return nil, fmt.Errorf("text is %d characters, exceeds the %d-character cap per action", len(runes), maxTypeTextLen)
	}
	for _, r := range runes {
		C.postUnicodeKeyEvent(C.UniChar(r), 1)
		C.postUnicodeKeyEvent(C.UniChar(r), 0)
	}
	return map[string]any{"characters": len(runes)}, nil
}

// DesktopScroll sends a scroll-wheel event. scroll_x/scroll_y are taken as a
// direct line count, matching OpenAI's action shape rather than pixel
// distance.
func DesktopScroll(params map[string]any) (map[string]any, error) {
	xf, err := requireNumberParam(params, "x")
	if err != nil {
		return nil, err
	}
	yf, err := requireNumberParam(params, "y")
	if err != nil {
		return nil, err
	}
	x, y, err := clampToVirtualScreen(xf, yf)
	if err != nil {
		return nil, err
	}
	scrollY, _ := params["scroll_y"].(float64)
	scrollX, _ := params["scroll_x"].(float64)
	if scrollY == 0 && scrollX == 0 {
		return map[string]any{"scrolled": false}, nil
	}
	C.postMouseEvent(C.kCGEventMouseMoved, C.kCGMouseButtonLeft, C.double(x), C.double(y))
	C.postScrollEvent(C.int32_t(scrollY), C.int32_t(scrollX))
	return map[string]any{"scrolled": true}, nil
}
