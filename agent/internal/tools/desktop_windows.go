//go:build windows

package tools

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"image/png"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// desktop.* — computer-use addendum (docs/v0.1-computer-use-addendum.md).
// Backs the OpenAI Responses API `computer_use_preview` loop
// (backend/src/computer-use/index.ts): screenshot is read-risk and
// auto-executes; every action that actually changes device state
// (click/double_click/drag/keypress/type/scroll) is risk:"high" in
// registry.json, which policy-engine/index.ts never auto-executes regardless
// of tenant autonomy opt-in — the backend only ever dispatches these to the
// agent after a human has approved that exact action. This file re-validates
// every param independently anyway (bounds-clamping coordinates, allowlisting
// key names, capping typed-text length) — same defense-in-depth principle as
// browser_windows.go's OpenURL: never trust that upstream validation already
// happened.
//
// No screenshot/input-simulation library exists in go.mod — raw
// user32.dll/gdi32.dll calls via windows.NewLazySystemDLL, same style as
// eventlog_windows.go's wevtapi calls, rather than adding a third-party dep.
//
// HONEST GAP: like every other agent tool in this repo (see README "Status"),
// this is compile-verified only (GOOS=windows go build) — there is no Windows
// box in this dev environment to runtime-test SendInput/BitBlt against, so
// treat the Win32 struct layouts and coordinate math below as unverified
// until tried on a real machine.

var (
	user32 = windows.NewLazySystemDLL("user32.dll")
	gdi32  = windows.NewLazySystemDLL("gdi32.dll")

	procGetSystemMetrics    = user32.NewProc("GetSystemMetrics")
	procSendInput           = user32.NewProc("SendInput")
	procGetDC               = user32.NewProc("GetDC")
	procReleaseDC           = user32.NewProc("ReleaseDC")
	procGetDesktopWindow    = user32.NewProc("GetDesktopWindow")
	procCreateCompatibleDC  = gdi32.NewProc("CreateCompatibleDC")
	procCreateCompatibleBmp = gdi32.NewProc("CreateCompatibleBitmap")
	procSelectObject        = gdi32.NewProc("SelectObject")
	procBitBlt              = gdi32.NewProc("BitBlt")
	procGetDIBits           = gdi32.NewProc("GetDIBits")
	procDeleteObject        = gdi32.NewProc("DeleteObject")
	procDeleteDC            = gdi32.NewProc("DeleteDC")
)

const (
	smXVirtualScreen  = 76
	smYVirtualScreen  = 77
	smCXVirtualScreen = 78
	smCYVirtualScreen = 79

	srcCopy      = 0x00CC0020
	captureBlt   = 0x40000000
	biRGB        = 0
	dibRGBColors = 0
)

func getSystemMetric(index int) int32 {
	r, _, _ := procGetSystemMetrics.Call(uintptr(index))
	return int32(r)
}

// virtualScreenBounds returns the bounding box of ALL monitors (a negative
// origin is normal in multi-monitor setups where a secondary display sits
// left of or above the primary one).
func virtualScreenBounds() (originX, originY, width, height int32) {
	return getSystemMetric(smXVirtualScreen), getSystemMetric(smYVirtualScreen),
		getSystemMetric(smCXVirtualScreen), getSystemMetric(smCYVirtualScreen)
}

// clampToVirtualScreen re-validates x,y independently of whatever the backend
// already claims is safe — same principle as browser_windows.go re-checking
// the URL scheme/path. An out-of-bounds coordinate is a hard error, not
// silently clamped, so a bad request surfaces instead of clicking the wrong
// spot.
func clampToVirtualScreen(x, y float64) (int32, int32, error) {
	originX, originY, width, height := virtualScreenBounds()
	xi, yi := int32(x), int32(y)
	if !coordInBounds(xi, yi, originX, originY, width, height) {
		return 0, 0, fmt.Errorf("coordinate (%d, %d) is outside the virtual screen bounds (%d,%d)-(%d,%d)",
			xi, yi, originX, originY, originX+width, originY+height)
	}
	return xi, yi, nil
}

// requireNumberParam/stringSlice/the per-action caps moved to params.go (no
// build tag) — shared with desktop_darwin.go/desktop_linux.go.

// ---- SendInput plumbing -----------------------------------------------

const (
	inputMouse    = 0
	inputKeyboard = 1

	mouseEventfMove        = 0x0001
	mouseEventfAbsolute    = 0x8000
	mouseEventfVirtualDesk = 0x4000
	mouseEventfLeftDown    = 0x0002
	mouseEventfLeftUp      = 0x0004
	mouseEventfRightDown   = 0x0008
	mouseEventfRightUp     = 0x0010
	mouseEventfMiddleDown  = 0x0020
	mouseEventfMiddleUp    = 0x0040
	mouseEventfXDown       = 0x0080
	mouseEventfXUp         = 0x0100
	mouseEventfWheel       = 0x0800
	xButton1               = 1
	xButton2               = 2

	keyEventfExtendedKey = 0x0001
	keyEventfKeyUp       = 0x0002
	keyEventfUnicode     = 0x0004
)

// mouseInput/keybdInput/rawInput reproduce Win32's INPUT struct, which is a
// tagged union (MOUSEINPUT | KEYBDINPUT | HARDWAREINPUT) — Go has no unions,
// so rawInput embeds the largest member (mouseInput, 32 bytes on amd64) and
// keyEvent() casts a *keybdInput onto the same memory to fill it instead,
// leaving the unused tail zeroed. sizeof(rawInput) must equal Win32's
// sizeof(INPUT) (40 bytes on amd64: 4 type + 4 padding + 32 union) for
// SendInput's cbSize check to accept it.
type mouseInput struct {
	Dx          int32
	Dy          int32
	MouseData   uint32
	DwFlags     uint32
	Time        uint32
	DwExtraInfo uintptr
}

type keybdInput struct {
	WVk         uint16
	WScan       uint16
	DwFlags     uint32
	Time        uint32
	DwExtraInfo uintptr
}

type rawInput struct {
	Type uint32
	_    uint32
	Mi   mouseInput
}

func sendInputs(inputs []rawInput) error {
	if len(inputs) == 0 {
		return nil
	}
	ret, _, err := procSendInput.Call(
		uintptr(len(inputs)),
		uintptr(unsafe.Pointer(&inputs[0])),
		unsafe.Sizeof(inputs[0]),
	)
	if int(ret) != len(inputs) {
		return fmt.Errorf("SendInput sent %d/%d events: %w", ret, len(inputs), err)
	}
	return nil
}

func absMouseInput(flags uint32, x, y int32, mouseData uint32) rawInput {
	originX, originY, width, height := virtualScreenBounds()
	norm := func(v, origin, size int32) int32 {
		if size <= 1 {
			return 0
		}
		return (v - origin) * 65535 / (size - 1)
	}
	return rawInput{
		Type: inputMouse,
		Mi: mouseInput{
			Dx:        norm(x, originX, width),
			Dy:        norm(y, originY, height),
			MouseData: mouseData,
			DwFlags:   flags | mouseEventfMove | mouseEventfAbsolute | mouseEventfVirtualDesk,
		},
	}
}

func buttonMouseInput(x, y int32, downFlag, upFlag uint32, mouseData uint32) []rawInput {
	move := absMouseInput(0, x, y, 0)
	down := absMouseInput(downFlag, x, y, mouseData)
	up := absMouseInput(upFlag, x, y, mouseData)
	return []rawInput{move, down, up}
}

func keyInput(vk uint16, flags uint32) rawInput {
	r := rawInput{Type: inputKeyboard}
	kb := (*keybdInput)(unsafe.Pointer(&r.Mi))
	kb.WVk = vk
	kb.DwFlags = flags
	return r
}

// ---- Key name allowlist -------------------------------------------------

// namedVirtualKeys covers the modifier/navigation/function keys a CUA model
// commonly requests. An unrecognized name fails closed — same principle as
// the tool-name allowlist itself (agent/internal/tools/registry.go) — rather
// than guessing a virtual-key code for something unknown.
var namedVirtualKeys = map[string]uint16{
	"ctrl": 0x11, "control": 0x11, "lcontrol": 0xA2, "rcontrol": 0xA3,
	"alt": 0x12, "menu": 0x12, "lalt": 0xA4, "ralt": 0xA5,
	"shift": 0x10, "lshift": 0xA0, "rshift": 0xA1,
	"win": 0x5B, "cmd": 0x5B, "meta": 0x5B, "super": 0x5B,
	"enter": 0x0D, "return": 0x0D,
	"tab": 0x09, "esc": 0x1B, "escape": 0x1B,
	"backspace": 0x08, "delete": 0x2E, "del": 0x2E, "insert": 0x2D,
	"space": 0x20,
	"up":    0x26, "down": 0x28, "left": 0x25, "right": 0x27,
	"home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22,
	"f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73, "f5": 0x74, "f6": 0x75,
	"f7": 0x76, "f8": 0x77, "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
}

func virtualKeyFor(name string) (uint16, error) {
	n := strings.ToLower(strings.TrimSpace(name))
	if vk, ok := namedVirtualKeys[n]; ok {
		return vk, nil
	}
	// Single alphanumeric character — VK codes for '0'-'9'/'A'-'Z' equal their
	// ASCII value on Windows.
	if len(n) == 1 {
		c := n[0]
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') {
			return uint16(strings.ToUpper(n)[0]), nil
		}
	}
	return 0, fmt.Errorf("key %q is not in the allowlist — refusing to guess a virtual-key code", name)
}

func pressKeys(keys []string) error {
	vks := make([]uint16, 0, len(keys))
	for _, k := range keys {
		vk, err := virtualKeyFor(k)
		if err != nil {
			return err
		}
		vks = append(vks, vk)
	}
	inputs := make([]rawInput, 0, len(vks)*2)
	for _, vk := range vks {
		inputs = append(inputs, keyInput(vk, 0))
	}
	for i := len(vks) - 1; i >= 0; i-- {
		inputs = append(inputs, keyInput(vks[i], keyEventfKeyUp))
	}
	return sendInputs(inputs)
}

// ---- Tools ---------------------------------------------------------------

// DesktopScreenshot captures every monitor (the full virtual screen) via GDI
// BitBlt and returns it as a base64-encoded PNG. Read-risk, auto-executes —
// also doubles as the deterministic verification step for every write action
// below (registry.json's ["desktop.screenshot"]).
func DesktopScreenshot(params map[string]any) (map[string]any, error) {
	originX, originY, width, height := virtualScreenBounds()
	if width <= 0 || height <= 0 {
		return nil, fmt.Errorf("could not determine virtual screen size")
	}

	hdcScreen, _, _ := procGetDC.Call(0)
	if hdcScreen == 0 {
		return nil, fmt.Errorf("GetDC failed")
	}
	defer procReleaseDC.Call(0, hdcScreen)

	hdcMem, _, _ := procCreateCompatibleDC.Call(hdcScreen)
	if hdcMem == 0 {
		return nil, fmt.Errorf("CreateCompatibleDC failed")
	}
	defer procDeleteDC.Call(hdcMem)

	hBitmap, _, _ := procCreateCompatibleBmp.Call(hdcScreen, uintptr(width), uintptr(height))
	if hBitmap == 0 {
		return nil, fmt.Errorf("CreateCompatibleBitmap failed")
	}
	defer procDeleteObject.Call(hBitmap)

	oldObj, _, _ := procSelectObject.Call(hdcMem, hBitmap)
	defer procSelectObject.Call(hdcMem, oldObj)

	ret, _, err := procBitBlt.Call(
		hdcMem, 0, 0, uintptr(width), uintptr(height),
		hdcScreen, uintptr(originX), uintptr(originY),
		uintptr(srcCopy|captureBlt),
	)
	if ret == 0 {
		return nil, fmt.Errorf("BitBlt failed: %w", err)
	}

	type bitmapInfoHeader struct {
		Size          uint32
		Width         int32
		Height        int32
		Planes        uint16
		BitCount      uint16
		Compression   uint32
		SizeImage     uint32
		XPelsPerMeter int32
		YPelsPerMeter int32
		ClrUsed       uint32
		ClrImportant  uint32
	}
	hdr := bitmapInfoHeader{
		Width:       width,
		Height:      -height, // negative = top-down DIB, matches image.RGBA row order
		Planes:      1,
		BitCount:    32,
		Compression: biRGB,
	}
	hdr.Size = uint32(unsafe.Sizeof(hdr))

	pixels := make([]byte, int(width)*int(height)*4)
	linesRead, _, _ := procGetDIBits.Call(
		hdcMem, hBitmap, 0, uintptr(height),
		uintptr(unsafe.Pointer(&pixels[0])),
		uintptr(unsafe.Pointer(&hdr)),
		dibRGBColors,
	)
	if linesRead == 0 {
		return nil, fmt.Errorf("GetDIBits failed")
	}

	img := image.NewRGBA(image.Rect(0, 0, int(width), int(height)))
	for i := 0; i < len(pixels); i += 4 {
		// GetDIBits with BI_RGB returns BGRA byte order.
		img.Pix[i+0] = pixels[i+2] // R
		img.Pix[i+1] = pixels[i+1] // G
		img.Pix[i+2] = pixels[i+0] // B
		img.Pix[i+3] = 0xFF        // A — desktop capture has no real alpha channel
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
}

// DesktopMove moves the cursor without clicking — no device state change,
// read-risk, auto-executes.
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
	if err := sendInputs([]rawInput{absMouseInput(0, x, y, 0)}); err != nil {
		return nil, err
	}
	return map[string]any{"x": x, "y": y}, nil
}

// DesktopWait sleeps for the requested duration (ms, capped). No device state
// change, read-risk.
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

func mouseButtonFlags(button string) (down, up uint32, data uint32, err error) {
	switch button {
	case "", "left":
		return mouseEventfLeftDown, mouseEventfLeftUp, 0, nil
	case "right":
		return mouseEventfRightDown, mouseEventfRightUp, 0, nil
	case "wheel":
		return mouseEventfMiddleDown, mouseEventfMiddleUp, 0, nil
	case "back":
		return mouseEventfXDown, mouseEventfXUp, xButton1, nil
	case "forward":
		return mouseEventfXDown, mouseEventfXUp, xButton2, nil
	default:
		return 0, 0, 0, fmt.Errorf("unknown button %q — refusing to guess", button)
	}
}

// DesktopClick moves to (x,y) and clicks the given button. risk:"high" in
// registry.json — the backend only ever dispatches this after a human has
// approved this specific click.
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
	down, up, data, err := mouseButtonFlags(button)
	if err != nil {
		return nil, err
	}
	if err := sendInputs(buttonMouseInput(x, y, down, up, data)); err != nil {
		return nil, err
	}
	return map[string]any{"x": x, "y": y, "button": button}, nil
}

// DesktopDoubleClick is DesktopClick's button/up/down pair sent twice in
// quick succession (left button only — OpenAI's double_click action carries
// no button field).
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
	inputs := append(buttonMouseInput(x, y, mouseEventfLeftDown, mouseEventfLeftUp, 0),
		buttonMouseInput(x, y, mouseEventfLeftDown, mouseEventfLeftUp, 0)...)
	if err := sendInputs(inputs); err != nil {
		return nil, err
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

	inputs := []rawInput{absMouseInput(0, points[0].x, points[0].y, 0), absMouseInput(mouseEventfLeftDown, points[0].x, points[0].y, 0)}
	for _, p := range points[1:] {
		inputs = append(inputs, absMouseInput(0, p.x, p.y, 0))
	}
	last := points[len(points)-1]
	inputs = append(inputs, absMouseInput(mouseEventfLeftUp, last.x, last.y, 0))

	if err := sendInputs(inputs); err != nil {
		return nil, err
	}
	return map[string]any{"points": len(points)}, nil
}

// DesktopKeypress presses (and releases, in reverse order) a chord of named
// keys. Every name must resolve through the namedVirtualKeys/single-char
// allowlist above — an unrecognized key name is a hard error, never guessed.
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
	if err := pressKeys(keys); err != nil {
		return nil, err
	}
	return map[string]any{"keys": keys}, nil
}

// DesktopType sends text character-by-character via Unicode key events
// (KEYEVENTF_UNICODE — works for arbitrary characters without needing a
// layout-specific virtual-key mapping). risk:"high", length-capped.
func DesktopType(params map[string]any) (map[string]any, error) {
	text, err := requireStringParam(params, "text")
	if err != nil {
		return nil, err
	}
	runes := []rune(text)
	if len(runes) > maxTypeTextLen {
		return nil, fmt.Errorf("text is %d characters, exceeds the %d-character cap per action", len(runes), maxTypeTextLen)
	}

	inputs := make([]rawInput, 0, len(runes)*2)
	for _, r := range runes {
		down := rawInput{Type: inputKeyboard}
		kbDown := (*keybdInput)(unsafe.Pointer(&down.Mi))
		kbDown.WScan = uint16(r)
		kbDown.DwFlags = keyEventfUnicode

		up := rawInput{Type: inputKeyboard}
		kbUp := (*keybdInput)(unsafe.Pointer(&up.Mi))
		kbUp.WScan = uint16(r)
		kbUp.DwFlags = keyEventfUnicode | keyEventfKeyUp

		inputs = append(inputs, down, up)
	}
	if err := sendInputs(inputs); err != nil {
		return nil, err
	}
	return map[string]any{"characters": len(runes)}, nil
}

// DesktopScroll sends a vertical and/or horizontal mouse-wheel event at
// (x,y). One wheel "click" is WHEEL_DELTA (120) per the Win32 constant;
// scroll_x/scroll_y here are taken as a direct multiple of that, matching
// OpenAI's action shape rather than pixel distance.
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

	const wheelDelta = 120
	var inputs []rawInput
	if scrollY != 0 {
		inputs = append(inputs, absMouseInput(mouseEventfWheel, x, y, uint32(int32(scrollY*wheelDelta))))
	}
	if scrollX != 0 {
		const mouseEventfHWheel = 0x01000
		inputs = append(inputs, absMouseInput(mouseEventfHWheel, x, y, uint32(int32(scrollX*wheelDelta))))
	}
	if len(inputs) == 0 {
		return map[string]any{"scrolled": false}, nil
	}
	if err := sendInputs(inputs); err != nil {
		return nil, err
	}
	return map[string]any{"scrolled": true}, nil
}

var _ = procGetDesktopWindow // reserved for future window-scoped (vs. full-desktop) capture
