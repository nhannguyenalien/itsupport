package shellrun

import "regexp"

var redactions = []struct {
	re   *regexp.Regexp
	with string
}{
	{regexp.MustCompile(`(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(-----END [A-Z ]*PRIVATE KEY-----|\z)`), "[REDACTED PRIVATE KEY]"},
	{regexp.MustCompile(`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`), "[REDACTED JWT]"},
	{regexp.MustCompile(`(?i)(authorization\s*[:=]\s*)(bearer\s+|basic\s+)?[^\s"',]+`), "${1}[REDACTED]"},
	{regexp.MustCompile(`(?i)([A-Za-z][A-Za-z0-9+.-]*://[^\s:/@"']+:)[^\s@/"']+@`), "${1}[REDACTED]@"},
	{regexp.MustCompile(`(?i)([A-Za-z0-9_.-]*(?:pass(?:word|wd)?|secret|token|key|credential|auth|dsn|salt|signature)[A-Za-z0-9_.-]*"?\s*[:=]\s*"?)[^\s"',;]+`), "${1}[REDACTED]"},
}

// Redact removes secrets from command output before it leaves the device.
func Redact(s string) string {
	for _, r := range redactions {
		s = r.re.ReplaceAllString(s, r.with)
	}
	return s
}
