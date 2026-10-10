// Package shellrun classifies and runs the free-form commands behind the
// Linux `shell.run` tool (docs/v0.3-linux-shell-addendum.md).
//
// A command is an argv vector — never a shell string — and is classified as
// read (runs unattended), write (needs a human approval) or deny (never runs).
// The default is write: anything not matched by a read rule is write. The rules
// live in rules.json, shared with the backend's TypeScript mirror
// (backend/src/shell-run); both implementations are tested against the same
// fixtures so they cannot silently drift.
package shellrun

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"path"
	"regexp"
	"strings"
	"unicode/utf8"
)

//go:embed rules.json
var RulesJSON []byte

type Class string

const (
	Read  Class = "read"
	Write Class = "write"
	Deny  Class = "deny"
)

type Verdict struct {
	Class  Class  `json:"class"`
	Rule   string `json:"rule"`
	Reason string `json:"reason,omitempty"`
}

type readRule struct {
	ID         string            `json:"id"`
	Bin        string            `json:"bin"`
	Sub        []string          `json:"sub"`
	Flags      []string          `json:"flags"`
	ValueFlags map[string]string `json:"valueFlags"`
	Short      string            `json:"short"`
	MaxPos     int               `json:"maxPos"`
	Pos        string            `json:"pos"`
	Paths      string            `json:"paths"`

	flagSet   map[string]bool
	valueRe   map[string]*regexp.Regexp
	posRegexp *regexp.Regexp
}

type rules struct {
	ExecDirs     []string                         `json:"execDirs"`
	Limits       struct{ MaxArgs, MaxArgLen int } `json:"limits"`
	ContentRoots []string                         `json:"contentRoots"`
	Deny         struct {
		Binaries       []string `json:"binaries"`
		BinaryPrefixes []string `json:"binaryPrefixes"`
		ArgSubstrings  []string `json:"argSubstrings"`
		ArgSuffixes    []string `json:"argSuffixes"`
		PathRegex      []string `json:"pathRegex"`
		ArgPrefixes    []string `json:"argPrefixes"`
		Systemctl      struct {
			Bins          []string `json:"bins"`
			MutatingVerbs []string `json:"mutatingVerbs"`
			Protected     []string `json:"protected"`
		} `json:"systemctl"`
		RecursiveCritical struct {
			Bins           []string `json:"bins"`
			RecursiveFlags []string `json:"recursiveFlags"`
			RecursiveShort string   `json:"recursiveShort"`
			ExtraDenyFlags []string `json:"extraDenyFlags"`
			Critical       []string `json:"critical"`
		} `json:"recursiveCritical"`
		ForceFlags struct {
			Bins  []string `json:"bins"`
			Flags []string `json:"flags"`
		} `json:"forceFlags"`
	} `json:"deny"`
	Read []*readRule `json:"read"`

	denyBins     map[string]bool
	pathRe       []*regexp.Regexp
	byBin        map[string][]*readRule
	defaultPosRe *regexp.Regexp
}

var loaded = mustLoad()

func mustLoad() *rules {
	r := &rules{}
	if err := json.Unmarshal(RulesJSON, r); err != nil {
		panic(fmt.Sprintf("shellrun: bad rules.json: %v", err))
	}
	r.denyBins = map[string]bool{}
	for _, b := range r.Deny.Binaries {
		r.denyBins[b] = true
	}
	for _, p := range r.Deny.PathRegex {
		r.pathRe = append(r.pathRe, regexp.MustCompile(p))
	}
	r.defaultPosRe = regexp.MustCompile(`^[A-Za-z0-9_/.][A-Za-z0-9_.:/@%+,=-]{0,255}$`)
	r.byBin = map[string][]*readRule{}
	for _, rr := range r.Read {
		rr.flagSet = map[string]bool{}
		for _, f := range rr.Flags {
			rr.flagSet[f] = true
		}
		rr.valueRe = map[string]*regexp.Regexp{}
		for name, re := range rr.ValueFlags {
			rr.valueRe[name] = regexp.MustCompile(re)
		}
		rr.posRegexp = r.defaultPosRe
		if rr.Pos != "" {
			rr.posRegexp = regexp.MustCompile(rr.Pos)
		}
		r.byBin[rr.Bin] = append(r.byBin[rr.Bin], rr)
	}
	return r
}

// ExecDirs is the fixed PATH the runner resolves executables from.
func ExecDirs() []string { return loaded.ExecDirs }

// Name returns the executable's base name when argv[0] is acceptable
// (a bare name, or an absolute path directly inside a fixed exec directory).
func Name(argv []string) (string, bool) {
	if len(argv) == 0 {
		return "", false
	}
	b := argv[0]
	if !strings.Contains(b, "/") {
		return b, b != "" && b != "." && b != ".."
	}
	dir, base := path.Split(b)
	dir = strings.TrimSuffix(dir, "/")
	for _, d := range loaded.ExecDirs {
		if dir == d && base != "" {
			return base, true
		}
	}
	return "", false
}

// Classify returns the verdict for an argv vector. It is purely lexical;
// callers that read files must additionally apply CheckResolvedPath.
func Classify(argv []string) Verdict {
	r := loaded
	if len(argv) == 0 || len(argv) > r.Limits.MaxArgs {
		return Verdict{Deny, "argv", "argv must have 1.." + fmt.Sprint(r.Limits.MaxArgs) + " items"}
	}
	for _, a := range argv {
		if len(a) > r.Limits.MaxArgLen || !utf8.ValidString(a) || strings.ContainsRune(a, 0) {
			return Verdict{Deny, "argv", "argument is too long, not UTF-8, or contains NUL"}
		}
	}
	name, ok := Name(argv)
	if !ok {
		return Verdict{Deny, "argv0", "executable must be a bare name or live directly in " + strings.Join(r.ExecDirs, ", ")}
	}
	args := argv[1:]
	if v, hit := denyVerdict(r, name, args); hit {
		return v
	}
	for _, rule := range r.byBin[name] {
		if matches(r, rule, args) {
			return Verdict{Read, rule.ID, ""}
		}
	}
	return Verdict{Write, "default", "not covered by a read rule"}
}

func in(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func denyVerdict(r *rules, name string, args []string) (Verdict, bool) {
	d := func(rule, why string) (Verdict, bool) { return Verdict{Deny, rule, why}, true }
	if r.denyBins[name] {
		return d("deny.binary", name+" is never allowed")
	}
	for _, p := range r.Deny.BinaryPrefixes {
		if strings.HasPrefix(name, p) {
			return d("deny.binary", name+" is never allowed")
		}
	}
	for _, a := range args {
		l := strings.ToLower(a)
		for _, s := range r.Deny.ArgSubstrings {
			if strings.Contains(l, s) {
				return d("deny.path", "argument touches protected material ("+s+")")
			}
		}
		for _, s := range r.Deny.ArgSuffixes {
			if strings.HasSuffix(l, s) {
				return d("deny.path", "argument names a key or certificate file")
			}
		}
		for _, p := range r.Deny.ArgPrefixes {
			if strings.HasPrefix(l, p) {
				return d("deny.destructive", "writing to a block device")
			}
		}
		if strings.HasPrefix(a, "/") {
			c := path.Clean(a)
			for _, re := range r.pathRe {
				if re.MatchString(c) {
					return d("deny.path", "argument touches protected process memory or environment")
				}
			}
		}
	}
	if in(r.Deny.Systemctl.Bins, name) {
		mutating, protected := false, false
		for _, a := range args {
			if in(r.Deny.Systemctl.MutatingVerbs, a) {
				mutating = true
			}
			for _, p := range r.Deny.Systemctl.Protected {
				if strings.Contains(strings.ToLower(a), p) {
					protected = true
				}
			}
		}
		if mutating && protected {
			return d("deny.agent", "cannot change the support agent's own services")
		}
	}
	rc := r.Deny.RecursiveCritical
	if in(rc.Bins, name) {
		recursive := false
		for _, a := range args {
			if in(rc.ExtraDenyFlags, a) {
				return d("deny.destructive", a+" is never allowed")
			}
			if in(rc.RecursiveFlags, a) {
				recursive = true
			}
			if len(a) > 1 && a[0] == '-' && a[1] != '-' && strings.ContainsAny(a[1:], rc.RecursiveShort) {
				recursive = true
			}
		}
		if recursive {
			for _, a := range args {
				if strings.HasPrefix(a, "-") {
					continue
				}
				if in(rc.Critical, path.Clean("/"+strings.TrimPrefix(a, "/"))) && strings.HasPrefix(a, "/") || a == "/*" {
					return d("deny.destructive", "recursive change on a system directory")
				}
			}
		}
	}
	if in(r.Deny.ForceFlags.Bins, name) {
		for _, a := range args {
			if in(r.Deny.ForceFlags.Flags, a) {
				return d("deny.destructive", "forced power action")
			}
		}
	}
	return Verdict{}, false
}

func matches(r *rules, rule *readRule, args []string) bool {
	if len(args) < len(rule.Sub) {
		return false
	}
	for i, s := range rule.Sub {
		if args[i] != s {
			return false
		}
	}
	rest := args[len(rule.Sub):]
	pos := 0
	for j := 0; j < len(rest); j++ {
		a := rest[j]
		switch {
		case a == "--":
			return false
		case rule.flagSet[a]:
			// exact bool flag
		case strings.HasPrefix(a, "--"):
			name, val, hasVal := strings.Cut(a, "=")
			re, ok := rule.valueRe[name]
			if !ok {
				return false
			}
			if !hasVal {
				j++
				if j >= len(rest) {
					return false
				}
				val = rest[j]
			}
			if !re.MatchString(val) {
				return false
			}
		case len(a) > 1 && a[0] == '-':
			if re, ok := rule.valueRe[a]; ok {
				j++
				if j >= len(rest) || !re.MatchString(rest[j]) {
					return false
				}
			} else if rule.Short != "" && onlyChars(a[1:], rule.Short) {
				// combined short flags
			} else {
				return false
			}
		default:
			pos++
			if pos > rule.MaxPos || !rule.posRegexp.MatchString(a) || hasDotDot(a) {
				return false
			}
			if rule.Paths != "" && !lexicalPathOK(r, a, rule.Paths == "content") {
				return false
			}
		}
	}
	return true
}

func onlyChars(s, set string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if !strings.ContainsRune(set, c) {
			return false
		}
	}
	return true
}

func hasDotDot(a string) bool {
	for _, seg := range strings.Split(a, "/") {
		if seg == ".." {
			return true
		}
	}
	return false
}

func lexicalPathOK(r *rules, p string, content bool) bool {
	if !strings.HasPrefix(p, "/") {
		return false
	}
	c := path.Clean(p)
	for _, re := range r.pathRe {
		if re.MatchString(c) {
			return false
		}
	}
	if !content {
		return true
	}
	for _, root := range r.ContentRoots {
		if c == root || strings.HasPrefix(c, root+"/") {
			return true
		}
	}
	return false
}

// PathAllowedAfterResolve re-checks a read command's path argument after
// symlinks are resolved: a link under /var/log pointing at /etc/shadow must
// not read. content is true for cat/head/tail.
func PathAllowedAfterResolve(resolved string, content bool) bool {
	if !lexicalPathOK(loaded, resolved, content) {
		return false
	}
	l := strings.ToLower(resolved)
	for _, s := range loaded.Deny.ArgSubstrings {
		if strings.Contains(l, s) {
			return false
		}
	}
	for _, s := range loaded.Deny.ArgSuffixes {
		if strings.HasSuffix(l, s) {
			return false
		}
	}
	return true
}

// PathArgs returns the path-like arguments of a read-class command together
// with whether the matched rule reads file contents, for the resolve check.
func PathArgs(argv []string) (paths []string, content bool) {
	name, ok := Name(argv)
	if !ok {
		return nil, false
	}
	for _, rule := range loaded.byBin[name] {
		if rule.Paths != "" && matches(loaded, rule, argv[1:]) {
			for _, a := range argv[1:] {
				if strings.HasPrefix(a, "/") {
					paths = append(paths, a)
				}
			}
			return paths, rule.Paths == "content"
		}
	}
	return nil, false
}
