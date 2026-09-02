// Package transport is the agent's HTTP client for the backend. v0.1 talks
// plain HTTPS with a bearer-style device token embedded in the request — real
// mTLS (client cert issued at enrollment, see backend/src/enrollment/routes.ts
// TODO) is not wired in yet. Swapping the transport.Client below to present a
// client cert instead of a header is a contained change once the backend PKI
// side exists; nothing above this package should need to change.
package transport

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type Client struct {
	BaseURL  string
	DeviceID string
	http     *http.Client
}

func NewClient(baseURL, deviceID string) *Client {
	return &Client{
		BaseURL:  baseURL,
		DeviceID: deviceID,
		http:     &http.Client{Timeout: 15 * time.Second},
	}
}

type PendingCall struct {
	ID     string         `json:"id"`
	Tool   string         `json:"tool"`
	Params map[string]any `json:"params"`
	Risk   string         `json:"risk"`
}

func (c *Client) PollPending() ([]PendingCall, error) {
	url := fmt.Sprintf("%s/devices/%s/tool-calls/pending", c.BaseURL, c.DeviceID)
	resp, err := c.http.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("poll pending: status %d: %s", resp.StatusCode, body)
	}
	var calls []PendingCall
	if err := json.NewDecoder(resp.Body).Decode(&calls); err != nil {
		return nil, err
	}
	return calls, nil
}

type ResultPayload struct {
	Result       string         `json:"result"`
	ResultData   map[string]any `json:"resultData,omitempty"`
	ErrorMessage string         `json:"errorMessage,omitempty"`
}

func (c *Client) ReportResult(toolCallID string, payload ResultPayload) error {
	url := fmt.Sprintf("%s/tool-calls/%s/result", c.BaseURL, toolCallID)
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	resp, err := c.http.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("report result: status %d: %s", resp.StatusCode, respBody)
	}
	return nil
}
