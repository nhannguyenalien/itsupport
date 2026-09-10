//go:build windows

package tools

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// eventlog.read — pulls recent warning/error records from a Windows event
// channel through the modern Event Log API (wevtapi), newest first, rendered
// as XML.
//
// The agent deliberately does NOT redact here. Per docs/v0.1-spec.md's data
// privacy section the backend orchestrator filters and redacts (usernames,
// paths, emails, IPs) against the tenant's policy before anything reaches the
// LLM — and it wants the full structured XML to do that precisely. A partial
// redaction at this layer would just lose signal the policy might allow.

var (
	wevtapi = windows.NewLazySystemDLL("wevtapi.dll")

	procEvtQuery  = wevtapi.NewProc("EvtQuery")
	procEvtNext   = wevtapi.NewProc("EvtNext")
	procEvtRender = wevtapi.NewProc("EvtRender")
	procEvtClose  = wevtapi.NewProc("EvtClose")
)

const (
	evtQueryChannelPath      = 0x1
	evtQueryReverseDirection = 0x200 // newest events first
	evtRenderEventXml        = 1
)

func renderEventXML(hEvent uintptr) string {
	var used, propCount uint32
	// Size probe.
	procEvtRender.Call(0, hEvent, evtRenderEventXml, 0, 0,
		uintptr(unsafe.Pointer(&used)), uintptr(unsafe.Pointer(&propCount)))
	if used == 0 {
		return ""
	}
	buf := make([]byte, used)
	ret, _, _ := procEvtRender.Call(
		0, hEvent, evtRenderEventXml,
		uintptr(len(buf)),
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(unsafe.Pointer(&used)),
		uintptr(unsafe.Pointer(&propCount)),
	)
	if ret == 0 {
		return ""
	}
	// EvtRender writes a UTF-16, NUL-terminated string into buf.
	u16 := unsafe.Slice((*uint16)(unsafe.Pointer(&buf[0])), used/2)
	return windows.UTF16ToString(u16)
}

// EventLogRead returns up to max_events (default 50, hard cap 200) recent
// Critical/Error/Warning events from log_name (default "System").
func EventLogRead(params map[string]any) (map[string]any, error) {
	logName := "System"
	if v, ok := params["log_name"].(string); ok && v != "" {
		logName = v
	}
	maxEvents := 50
	if v, ok := params["max_events"].(float64); ok && v > 0 {
		maxEvents = int(v)
	}
	if maxEvents > 200 {
		maxEvents = 200
	}

	if err := procEvtQuery.Find(); err != nil {
		return nil, fmt.Errorf("event log API unavailable on this host: %w", err)
	}

	channelPtr, err := windows.UTF16PtrFromString(logName)
	if err != nil {
		return nil, fmt.Errorf("invalid log_name %q: %w", logName, err)
	}
	queryPtr, _ := windows.UTF16PtrFromString("*[System[(Level=1 or Level=2 or Level=3)]]")

	hResults, _, callErr := procEvtQuery.Call(
		0,
		uintptr(unsafe.Pointer(channelPtr)),
		uintptr(unsafe.Pointer(queryPtr)),
		uintptr(evtQueryChannelPath|evtQueryReverseDirection),
	)
	if hResults == 0 {
		return nil, fmt.Errorf("EvtQuery(%q): %w", logName, callErr)
	}
	defer procEvtClose.Call(hResults)

	events := make([]string, 0, maxEvents)
	var batch [16]uintptr
	for len(events) < maxEvents {
		var returned uint32
		ret, _, _ := procEvtNext.Call(
			hResults,
			uintptr(len(batch)),
			uintptr(unsafe.Pointer(&batch[0])),
			5000, // ms
			0,
			uintptr(unsafe.Pointer(&returned)),
		)
		if ret == 0 || returned == 0 {
			break // ERROR_NO_MORE_ITEMS / ERROR_TIMEOUT — done
		}
		for i := uint32(0); i < returned; i++ {
			if len(events) < maxEvents {
				if xml := renderEventXML(batch[i]); xml != "" {
					events = append(events, xml)
				}
			}
			procEvtClose.Call(batch[i])
		}
	}

	return map[string]any{
		"log_name": logName,
		"events":   events,
		"count":    len(events),
	}, nil
}
