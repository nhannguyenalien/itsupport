// Package update implements the click-to-update flow for installed agents.
//
// A release is a manifest.json listing every binary with its SHA-256, plus
// manifest.sig: an Ed25519 signature over the exact manifest bytes, made with
// a release key that never leaves the release machine (cmd/releasesign).
// The agent only trusts ReleasePublicKey compiled into it, so a compromised
// web server or backend can at most withhold updates, never ship a binary of
// its own to customer machines.
package update

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// ReleasePublicKey verifies every manifest. Rotating it requires a release
// signed with the old key that carries the new one.
const ReleasePublicKey = "vQ5d9S3XHzt9JbMA223sQSmM5wfG+3I5yk3xypJBxLE="

type File struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type Manifest struct {
	Version  string `json:"version"`
	Platform string `json:"platform"`
	Files    []File `json:"files"`
}

var (
	versionPattern  = regexp.MustCompile(`^\d{1,4}\.\d{1,4}\.\d{1,4}$`)
	fileNamePattern = regexp.MustCompile(`^[a-z]{1,32}(\.exe)?$`)
	shaPattern      = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

func ValidVersion(v string) bool { return versionPattern.MatchString(v) }

// Newer reports whether a is a higher x.y.z version than b.
func Newer(a, b string) bool {
	var pa, pb [3]int
	fmt.Sscanf(a, "%d.%d.%d", &pa[0], &pa[1], &pa[2])
	fmt.Sscanf(b, "%d.%d.%d", &pb[0], &pb[1], &pb[2])
	for i := range pa {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	return false
}

// VerifyManifest checks the signature with publicKeyB64, then that the
// manifest is for this platform, names the requested version, and lists
// exactly the expected binaries with well-formed hashes.
func VerifyManifest(data []byte, signatureB64, publicKeyB64, platform, wantVersion string, wantFiles []string) (Manifest, error) {
	var m Manifest
	key, err := base64.StdEncoding.DecodeString(publicKeyB64)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return m, fmt.Errorf("release public key is not configured in this agent build")
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(signatureB64))
	if err != nil || len(sig) != ed25519.SignatureSize {
		return m, fmt.Errorf("manifest signature is malformed")
	}
	if !ed25519.Verify(ed25519.PublicKey(key), data, sig) {
		return m, fmt.Errorf("manifest signature does not match the release key")
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return m, fmt.Errorf("manifest is not valid JSON: %w", err)
	}
	if m.Platform != platform {
		return m, fmt.Errorf("manifest is for %q, this agent is %q", m.Platform, platform)
	}
	if !ValidVersion(m.Version) || m.Version != wantVersion {
		return m, fmt.Errorf("manifest version %q does not match requested %q", m.Version, wantVersion)
	}
	if len(m.Files) != len(wantFiles) {
		return m, fmt.Errorf("manifest lists %d files, expected %d", len(m.Files), len(wantFiles))
	}
	seen := map[string]bool{}
	for _, f := range m.Files {
		if !fileNamePattern.MatchString(f.Name) || !shaPattern.MatchString(f.SHA256) || f.Size <= 0 || f.Size > MaxBinarySize {
			return m, fmt.Errorf("manifest entry %q is invalid", f.Name)
		}
		seen[f.Name] = true
	}
	for _, name := range wantFiles {
		if !seen[name] {
			return m, fmt.Errorf("manifest is missing %q", name)
		}
	}
	return m, nil
}

// MaxBinarySize bounds every download (current binaries are ~7 MB).
const MaxBinarySize = 64 << 20
