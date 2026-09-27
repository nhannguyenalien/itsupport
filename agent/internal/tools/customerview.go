package tools

import (
	"fmt"
	"net/url"
	"regexp"
)

// desktop.open_customer_view — computer-use addendum
// (docs/v0.1-computer-use-addendum.md). Opens the customer's own default
// browser to a read-only-plus-chat status page so the person sitting at the
// machine can see what's happening and message the technician, without any
// approval controls (those stay technician-only). System-triggered once by
// backend/src/computer-use/index.ts's startSession(), never something the AI
// decides to call itself.
//
// Deliberately its own no-build-tag file (not merged into browser_windows.go):
// this validator is shared by all three OS-specific OpenCustomerView
// implementations (customerview_{windows,darwin,linux}.go), same reasoning
// as params.go/bounds.go — pure logic worth keeping in one place and
// unit-testable without any OS-specific build.

// customerViewPathRe matches exactly /tickets/<uuid>/customer — same
// defense-in-depth principle as browser_windows.go's OpenURL re-checking the
// URL even though the backend already computed it. Unlike OpenURL (which
// requires https strictly, since it carries OAuth flow context), http is
// also accepted here: this URL carries nothing but a ticket id, and the
// documented local-dev default (FRONTEND_URL=http://localhost:3001) is
// plain http.
var customerViewPathRe = regexp.MustCompile(`^/tickets/[0-9a-fA-F-]{36}/customer/?$`)

func validateCustomerViewURL(raw string) (string, error) {
	if raw == "" {
		return "", fmt.Errorf("missing url param")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("invalid url: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("refusing to open a url with scheme %q", u.Scheme)
	}
	if !customerViewPathRe.MatchString(u.Path) {
		return "", fmt.Errorf("refusing to open a url outside /tickets/<id>/customer — this tool is scoped to the customer status view only")
	}
	return raw, nil
}
