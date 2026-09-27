//go:build linux

package tools

// Allowlist on Linux only wires the 9 desktop.* computer-use tools
// (desktop_linux.go, an X11-only SCAFFOLD — see that file's header comment)
// — the Windows-specific IT tools have no Linux implementation and simply
// aren't listed here, same reasoning as registry_darwin.go.
var Allowlist = map[string]Definition{
	"desktop.screenshot":   {Fn: DesktopScreenshot, Risk: RiskRead},
	"desktop.move":         {Fn: DesktopMove, Risk: RiskRead},
	"desktop.wait":         {Fn: DesktopWait, Risk: RiskRead},
	"desktop.click":        {Fn: DesktopClick, Risk: RiskHigh},
	"desktop.double_click": {Fn: DesktopDoubleClick, Risk: RiskHigh},
	"desktop.drag":         {Fn: DesktopDrag, Risk: RiskHigh},
	"desktop.keypress":     {Fn: DesktopKeypress, Risk: RiskHigh},
	"desktop.type":         {Fn: DesktopType, Risk: RiskHigh},
	"desktop.scroll":       {Fn: DesktopScroll, Risk: RiskHigh},

	"desktop.open_customer_view": {Fn: OpenCustomerView, Risk: RiskRead},
}
