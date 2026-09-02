// Package ipc is the channel between the low-privilege connection daemon and
// the elevated executor process (docs/v0.1-spec.md process-separation diagram).
// v0.1 implements it as HMAC-signed HTTP over 127.0.0.1 — simplest thing that
// gives the executor a real "verify signature/schema before touching anything"
// boundary. Production hardening (Windows named pipe with an ACL restricting
// the client to the daemon's service account, instead of a loopback TCP port
// any local process could theoretically reach) is a follow-up, not done here —
// flagged rather than silently assumed equivalent.
package ipc

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

const DefaultAddr = "127.0.0.1:47800"

type ExecuteRequest struct {
	ToolCallID string         `json:"tool_call_id"`
	Tool       string         `json:"tool"`
	Params     map[string]any `json:"params"`
}

type ExecuteResponse struct {
	ToolCallID string         `json:"tool_call_id"`
	Success    bool           `json:"success"`
	Data       map[string]any `json:"data,omitempty"`
	Error      string         `json:"error,omitempty"`
}

// Sign returns a hex-encoded HMAC-SHA256 of body using secret. The executor
// recomputes this over the raw request body and rejects the request outright
// on mismatch — before unmarshalling JSON, before looking at the tool name.
func Sign(secret []byte, body []byte) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func Verify(secret []byte, body []byte, signatureHex string) bool {
	expected := Sign(secret, body)
	return hmac.Equal([]byte(expected), []byte(signatureHex))
}

func MarshalRequest(req ExecuteRequest) ([]byte, error) {
	return json.Marshal(req)
}
