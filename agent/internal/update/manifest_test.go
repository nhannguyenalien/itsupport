package update

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func signed(t *testing.T, m Manifest) ([]byte, string, string, ed25519.PrivateKey) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	data, _ := json.Marshal(m)
	return data, base64.StdEncoding.EncodeToString(ed25519.Sign(priv, data)), base64.StdEncoding.EncodeToString(pub), priv
}

var files = []string{"daemon.exe", "executor.exe"}

func good() Manifest {
	h := strings.Repeat("a", 64)
	return Manifest{Version: "0.4.0", Platform: "windows-amd64", Files: []File{{"daemon.exe", h, 10}, {"executor.exe", h, 10}}}
}

func TestVerifyAcceptsSignedManifest(t *testing.T) {
	data, sig, pub, _ := signed(t, good())
	if _, err := VerifyManifest(data, sig, pub, "windows-amd64", "0.4.0", files); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyRejectsTamperingAndMismatches(t *testing.T) {
	data, sig, pub, _ := signed(t, good())
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	tampered := []byte(strings.Replace(string(data), "0.4.0", "0.4.1", 1))
	cases := map[string]func() error{
		"tampered": func() error {
			_, err := VerifyManifest(tampered, sig, pub, "windows-amd64", "0.4.1", files)
			return err
		},
		"other key": func() error {
			_, err := VerifyManifest(data, sig, base64.StdEncoding.EncodeToString(otherPub), "windows-amd64", "0.4.0", files)
			return err
		},
		"unconfigured": func() error {
			_, err := VerifyManifest(data, sig, "REPLACED_BY_KEYGEN", "windows-amd64", "0.4.0", files)
			return err
		},
		"platform": func() error { _, err := VerifyManifest(data, sig, pub, "linux-amd64", "0.4.0", files); return err },
		"version":  func() error { _, err := VerifyManifest(data, sig, pub, "windows-amd64", "0.5.0", files); return err },
		"missing file": func() error {
			_, err := VerifyManifest(data, sig, pub, "windows-amd64", "0.4.0", []string{"daemon.exe", "telemetry.exe"})
			return err
		},
		"bad signature": func() error { _, err := VerifyManifest(data, "!!", pub, "windows-amd64", "0.4.0", files); return err },
	}
	for name, run := range cases {
		if run() == nil {
			t.Errorf("%s: expected rejection", name)
		}
	}
	bad := good()
	bad.Files[0].Name = `..\evil.exe`
	data2, sig2, pub2, _ := signed(t, bad)
	if _, err := VerifyManifest(data2, sig2, pub2, "windows-amd64", "0.4.0", files); err == nil {
		t.Error("path-like file name must be rejected")
	}
}

func TestNewer(t *testing.T) {
	if !Newer("0.10.0", "0.9.9") || Newer("0.3.0", "0.3.0") || Newer("0.2.9", "0.3.0") {
		t.Fatal("version comparison is wrong")
	}
}
