//go:build windows

package tools

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Printer tools for scenario A ("printer.status -> service.status -> [approval]
// -> service.restart -> printer.test -> resolved") plus printer.queue /
// printer.clear_queue. All go through winspool.drv directly — no shelling out
// to PowerShell's Get-Printer / Restart-Service equivalents.
//
// Struct layouts below mirror the Win32 headers for amd64 (the only arch the
// v0.1 agent ships for). Each is annotated with its expected size so a future
// arch port has a checklist.

var (
	winspool = windows.NewLazySystemDLL("winspool.drv")

	procOpenPrinterW       = winspool.NewProc("OpenPrinterW")
	procClosePrinter       = winspool.NewProc("ClosePrinter")
	procGetPrinterW        = winspool.NewProc("GetPrinterW")
	procSetPrinterW        = winspool.NewProc("SetPrinterW")
	procEnumPrintersW      = winspool.NewProc("EnumPrintersW")
	procEnumJobsW          = winspool.NewProc("EnumJobsW")
	procGetDefaultPrinterW = winspool.NewProc("GetDefaultPrinterW")
	procStartDocPrinterW   = winspool.NewProc("StartDocPrinterW")
	procEndDocPrinter      = winspool.NewProc("EndDocPrinter")
	procStartPagePrinter   = winspool.NewProc("StartPagePrinter")
	procEndPagePrinter     = winspool.NewProc("EndPagePrinter")
	procWritePrinter       = winspool.NewProc("WritePrinter")
)

const (
	printerEnumLocal       = 0x00000002
	printerEnumConnections = 0x00000004

	printerAllAccess    = 0x000F000C // PRINTER_ALL_ACCESS — needed for the PURGE control
	printerControlPurge = 3          // PRINTER_CONTROL_PURGE

	printerStatusOffline = 0x00000080
)

// PRINTER_DEFAULTSW — 24 bytes (amd64).
type printerDefaultsW struct {
	pDatatype     *uint16
	pDevMode      uintptr
	desiredAccess uint32
}

// PRINTER_INFO_4W — 24 bytes (amd64). Enough to enumerate names; status comes
// from a per-printer GetPrinter level 6 call.
type printerInfo4W struct {
	pPrinterName *uint16
	pServerName  *uint16
	attributes   uint32
}

// PRINTER_INFO_6 — 4 bytes. The whole point of using level 6: the status is a
// single DWORD, no nested pointers to marshal.
type printerInfo6 struct {
	dwStatus uint32
}

// DOC_INFO_1W — 24 bytes (amd64).
type docInfo1W struct {
	pDocName    *uint16
	pOutputFile *uint16
	pDatatype   *uint16
}

// JOB_INFO_1W — 96 bytes (amd64). The explicit pad makes the pointer block's
// 8-byte alignment obvious rather than implied.
type jobInfo1W struct {
	jobID        uint32
	_            uint32
	pPrinterName *uint16
	pMachineName *uint16
	pUserName    *uint16
	pDocument    *uint16
	pDatatype    *uint16
	pStatus      *uint16
	status       uint32
	priority     uint32
	position     uint32
	totalPages   uint32
	pagesPrinted uint32
	submitted    windows.Systemtime
}

var printerStatusBits = []struct {
	bit  uint32
	name string
}{
	{0x00000001, "PAUSED"},
	{0x00000002, "ERROR"},
	{0x00000004, "PENDING_DELETION"},
	{0x00000008, "PAPER_JAM"},
	{0x00000010, "PAPER_OUT"},
	{0x00000020, "MANUAL_FEED"},
	{0x00000040, "PAPER_PROBLEM"},
	{printerStatusOffline, "OFFLINE"},
	{0x00000100, "IO_ACTIVE"},
	{0x00000200, "BUSY"},
	{0x00000400, "PRINTING"},
	{0x00000800, "OUTPUT_BIN_FULL"},
	{0x00001000, "NOT_AVAILABLE"},
	{0x00002000, "WAITING"},
	{0x00004000, "PROCESSING"},
	{0x00008000, "INITIALIZING"},
	{0x00010000, "WARMING_UP"},
	{0x00020000, "TONER_LOW"},
	{0x00040000, "NO_TONER"},
	{0x00080000, "PAGE_PUNT"},
	{0x00100000, "USER_INTERVENTION"},
	{0x00200000, "OUT_OF_MEMORY"},
	{0x00400000, "DOOR_OPEN"},
	{0x00800000, "SERVER_UNKNOWN"},
	{0x01000000, "POWER_SAVE"},
}

func decodePrinterStatus(status uint32) []string {
	if status == 0 {
		return []string{"READY"}
	}
	out := make([]string, 0, 4)
	for _, s := range printerStatusBits {
		if status&s.bit != 0 {
			out = append(out, s.name)
		}
	}
	if len(out) == 0 {
		out = append(out, fmt.Sprintf("UNKNOWN(0x%08X)", status))
	}
	return out
}

func openPrinter(name string, admin bool) (windows.Handle, error) {
	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return 0, fmt.Errorf("invalid printer name %q: %w", name, err)
	}
	var h windows.Handle
	var ret uintptr
	var callErr error
	if admin {
		// Kept in this scope so the pointer stays live across the Call, and the
		// unsafe.Pointer->uintptr conversion happens inline in the arg list
		// (same pattern as system_windows.go).
		d := printerDefaultsW{desiredAccess: printerAllAccess}
		ret, _, callErr = procOpenPrinterW.Call(
			uintptr(unsafe.Pointer(namePtr)),
			uintptr(unsafe.Pointer(&h)),
			uintptr(unsafe.Pointer(&d)),
		)
	} else {
		ret, _, callErr = procOpenPrinterW.Call(
			uintptr(unsafe.Pointer(namePtr)),
			uintptr(unsafe.Pointer(&h)),
			0,
		)
	}
	if ret == 0 {
		return 0, fmt.Errorf("OpenPrinter(%q): %w", name, callErr)
	}
	return h, nil
}

func printerStatusFlags(h windows.Handle) (uint32, error) {
	// Real drivers can require more than sizeof(PRINTER_INFO_6) for level 6
	// (ERROR_INSUFFICIENT_BUFFER, "the data area passed to a system call is
	// too small"), so ask for the needed size first.
	var needed uint32
	procGetPrinterW.Call(uintptr(h), 6, 0, 0, uintptr(unsafe.Pointer(&needed)))
	if needed < uint32(unsafe.Sizeof(printerInfo6{})) {
		needed = uint32(unsafe.Sizeof(printerInfo6{}))
	}
	buf := make([]byte, needed)
	ret, _, callErr := procGetPrinterW.Call(
		uintptr(h),
		6,
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(needed),
		uintptr(unsafe.Pointer(&needed)),
	)
	if ret == 0 {
		return 0, fmt.Errorf("GetPrinter level 6: %w", callErr)
	}
	return (*printerInfo6)(unsafe.Pointer(&buf[0])).dwStatus, nil
}

func enumPrinterNames() ([]string, error) {
	const flags = uintptr(printerEnumLocal | printerEnumConnections)
	var needed, returned uint32

	// First call sizes the buffer (expected to "fail" with
	// ERROR_INSUFFICIENT_BUFFER and set `needed`).
	procEnumPrintersW.Call(flags, 0, 4, 0, 0,
		uintptr(unsafe.Pointer(&needed)), uintptr(unsafe.Pointer(&returned)))
	if needed == 0 {
		return nil, nil
	}

	buf := make([]byte, needed)
	ret, _, callErr := procEnumPrintersW.Call(
		flags, 0, 4,
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(needed),
		uintptr(unsafe.Pointer(&needed)),
		uintptr(unsafe.Pointer(&returned)),
	)
	if ret == 0 {
		return nil, fmt.Errorf("EnumPrinters: %w", callErr)
	}

	sz := unsafe.Sizeof(printerInfo4W{})
	names := make([]string, 0, returned)
	for i := uint32(0); i < returned; i++ {
		pi := (*printerInfo4W)(unsafe.Pointer(&buf[uintptr(i)*sz]))
		names = append(names, windows.UTF16PtrToString(pi.pPrinterName))
	}
	return names, nil
}

func defaultPrinterName() (string, error) {
	var size uint32
	procGetDefaultPrinterW.Call(0, uintptr(unsafe.Pointer(&size)))
	if size == 0 {
		return "", fmt.Errorf("no default printer is configured on this host")
	}
	buf := make([]uint16, size)
	ret, _, callErr := procGetDefaultPrinterW.Call(
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(unsafe.Pointer(&size)),
	)
	if ret == 0 {
		return "", fmt.Errorf("GetDefaultPrinter: %w", callErr)
	}
	return windows.UTF16ToString(buf), nil
}

// PrinterStatus reports each printer's status flags. With no printer_name it
// enumerates every local/connected printer; with one, it returns just that
// printer (and errors if it can't be opened).
func PrinterStatus(params map[string]any) (map[string]any, error) {
	name := ""
	if v, ok := params["printer_name"].(string); ok {
		name = v
	}

	var names []string
	if name != "" {
		names = []string{name}
	} else {
		var err error
		if names, err = enumPrinterNames(); err != nil {
			return nil, err
		}
	}

	printers := make([]map[string]any, 0, len(names))
	for _, n := range names {
		h, err := openPrinter(n, false)
		if err != nil {
			printers = append(printers, map[string]any{"name": n, "error": err.Error()})
			continue
		}
		status, err := printerStatusFlags(h)
		procClosePrinter.Call(uintptr(h))
		if err != nil {
			printers = append(printers, map[string]any{"name": n, "error": err.Error()})
			continue
		}
		printers = append(printers, map[string]any{
			"name":         n,
			"status_flags": status,
			"status":       decodePrinterStatus(status),
			"online":       status&printerStatusOffline == 0,
		})
	}

	if name != "" && len(printers) == 1 {
		if errStr, bad := printers[0]["error"].(string); bad {
			return nil, fmt.Errorf("printer %q: %s", name, errStr)
		}
		return printers[0], nil
	}
	return map[string]any{"printers": printers, "count": len(printers)}, nil
}

// PrinterQueue lists pending jobs for a printer (up to 256).
func PrinterQueue(params map[string]any) (map[string]any, error) {
	name, err := requireStringParam(params, "printer_name")
	if err != nil {
		return nil, err
	}
	h, err := openPrinter(name, false)
	if err != nil {
		return nil, err
	}
	defer procClosePrinter.Call(uintptr(h))

	const maxJobs = 256
	var needed, returned uint32
	procEnumJobsW.Call(uintptr(h), 0, maxJobs, 1, 0, 0,
		uintptr(unsafe.Pointer(&needed)), uintptr(unsafe.Pointer(&returned)))
	if needed == 0 {
		return map[string]any{"printer_name": name, "jobs": []any{}, "count": 0}, nil
	}

	buf := make([]byte, needed)
	ret, _, callErr := procEnumJobsW.Call(
		uintptr(h), 0, maxJobs, 1,
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(needed),
		uintptr(unsafe.Pointer(&needed)),
		uintptr(unsafe.Pointer(&returned)),
	)
	if ret == 0 {
		return nil, fmt.Errorf("EnumJobs(%q): %w", name, callErr)
	}

	sz := unsafe.Sizeof(jobInfo1W{})
	jobs := make([]map[string]any, 0, returned)
	for i := uint32(0); i < returned; i++ {
		j := (*jobInfo1W)(unsafe.Pointer(&buf[uintptr(i)*sz]))
		jobs = append(jobs, map[string]any{
			"job_id":        j.jobID,
			"document":      windows.UTF16PtrToString(j.pDocument),
			"user":          windows.UTF16PtrToString(j.pUserName),
			"status_flags":  j.status,
			"total_pages":   j.totalPages,
			"pages_printed": j.pagesPrinted,
			"position":      j.position,
		})
	}
	return map[string]any{"printer_name": name, "jobs": jobs, "count": len(jobs)}, nil
}

// PrinterClearQueue purges all jobs from a printer's queue via
// SetPrinter(PRINTER_CONTROL_PURGE). Write action (risk "low"); verification
// chain is a follow-up printer.queue (registry.json).
func PrinterClearQueue(params map[string]any) (map[string]any, error) {
	name, err := requireStringParam(params, "printer_name")
	if err != nil {
		return nil, err
	}
	h, err := openPrinter(name, true)
	if err != nil {
		return nil, err
	}
	defer procClosePrinter.Call(uintptr(h))

	ret, _, callErr := procSetPrinterW.Call(uintptr(h), 0, 0, printerControlPurge)
	if ret == 0 {
		return nil, fmt.Errorf("SetPrinter PURGE (%q): %w", name, callErr)
	}
	return map[string]any{"printer_name": name, "purged": true}, nil
}

// PrinterTest prints a test page to confirm the driver, spooler and queue
// accept work end to end — the terminal verification step in scenario A.
// It renders through GDI first (works for v4/XPS drivers that reject RAW),
// then falls back to a minimal RAW job for drivers without a usable GDI path.
func PrinterTest(params map[string]any) (map[string]any, error) {
	name := ""
	if v, ok := params["printer_name"].(string); ok {
		name = v
	}
	if name == "" {
		var err error
		if name, err = defaultPrinterName(); err != nil {
			return nil, fmt.Errorf("%w; pass printer_name from printer.details", err)
		}
	}

	jobID, gdiErr := gdiTestPage(name)
	if gdiErr == nil {
		return map[string]any{"printer_name": name, "job_id": jobID, "method": "gdi", "submitted": true}, nil
	}
	rawJobID, written, rawErr := rawTestPage(name)
	if rawErr != nil {
		return nil, fmt.Errorf("GDI test page failed (%v); RAW test page failed (%v)", gdiErr, rawErr)
	}
	return map[string]any{
		"printer_name":  name,
		"job_id":        rawJobID,
		"bytes_written": written,
		"method":        "raw",
		"gdi_error":     gdiErr.Error(),
		"submitted":     true,
	}, nil
}

// rawTestPage sends bytes straight to the device, so on a PostScript-only
// printer the page may print as literal text; it proves the spool path only.
func rawTestPage(name string) (uintptr, uint32, error) {
	h, err := openPrinter(name, false)
	if err != nil {
		return 0, 0, err
	}
	defer procClosePrinter.Call(uintptr(h))

	docName, _ := windows.UTF16PtrFromString("Support Agent test page")
	rawType, _ := windows.UTF16PtrFromString("RAW")
	doc := docInfo1W{pDocName: docName, pDatatype: rawType}

	jobID, _, callErr := procStartDocPrinterW.Call(uintptr(h), 1, uintptr(unsafe.Pointer(&doc)))
	if jobID == 0 {
		return 0, 0, fmt.Errorf("StartDocPrinter(%q): %w", name, callErr)
	}
	if ret, _, e := procStartPagePrinter.Call(uintptr(h)); ret == 0 {
		procEndDocPrinter.Call(uintptr(h))
		return 0, 0, fmt.Errorf("StartPagePrinter(%q): %w", name, e)
	}

	page := []byte("\r\n  Support Agent - printer test page\r\n" +
		"  Printed to verify the spooler and this queue are healthy.\r\n\r\n\f")
	var written uint32
	ret, _, e := procWritePrinter.Call(
		uintptr(h),
		uintptr(unsafe.Pointer(&page[0])),
		uintptr(uint32(len(page))),
		uintptr(unsafe.Pointer(&written)),
	)
	procEndPagePrinter.Call(uintptr(h))
	procEndDocPrinter.Call(uintptr(h))
	if ret == 0 {
		return 0, 0, fmt.Errorf("WritePrinter(%q): %w", name, e)
	}
	return jobID, written, nil
}
