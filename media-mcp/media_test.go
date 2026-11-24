package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type bearerTransport struct{ http.RoundTripper }

func (b bearerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	copy := r.Clone(r.Context())
	copy.Header.Set("Authorization", "Bearer test-secret")
	return b.RoundTripper.RoundTrip(copy)
}

func TestMCPToolSelectionAndValidation(t *testing.T) {
	var mux sync.Mutex
	var submissions []map[string]any
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet {
			if r.URL.Path != "/tasks/job_fixture" {
				t.Error("unexpected upstream path", r.URL.Path)
			}
			_, _ = w.Write([]byte(`{"output":{"task_status":"SUCCEEDED","video_url":"https://example.org/output.mp4"}}`))
			return
		}
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		mux.Lock()
		submissions = append(submissions, request)
		mux.Unlock()
		switch request["model"] {
		case "wan3.0-video":
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"code":"ModelNotFound"}`))
		case "qwen-image-2.1-turbo":
			_, _ = w.Write([]byte(`{"output":{"choices":[{"message":{"content":[{"image":"https://example.org/output.png"}]}}]}}`))
		default:
			if r.Header.Get("X-DashScope-Async") != "enable" {
				t.Error("missing async flag")
			}
			_, _ = w.Write([]byte(`{"output":{"task_id":"job_fixture","task_status":"PENDING"}}`))
		}
	}))
	defer provider.Close()
	service := &service{key: "test-provider", native: provider.URL, secret: []byte("job-secret"), client: provider.Client()}
	api := httptest.NewServer(httpHandler(newMCP(service), "test-secret"))
	defer api.Close()
	if res, err := http.Get(api.URL + "/mcp"); err != nil || res.StatusCode != http.StatusUnauthorized {
		t.Fatal("unprotected MCP endpoint", err, res)
	} else {
		_ = res.Body.Close()
	}
	ctx := context.Background()
	client := mcp.NewClient(&mcp.Implementation{Name: "integration-test", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: api.URL + "/mcp",
		HTTPClient: &http.Client{Transport: bearerTransport{http.DefaultTransport}}, DisableStandaloneSSE: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	list, err := session.ListTools(ctx, nil)
	if err != nil || len(list.Tools) != 7 {
		t.Fatalf("list: %v %v", list, err)
	}
	call := func(name string, args map[string]any, wantError bool) MediaResult {
		t.Helper()
		response, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
		if err != nil {
			if wantError {
				return MediaResult{}
			}
			t.Fatal(err)
		}
		if response.IsError != wantError {
			t.Fatalf("isError %v content %+v", response.IsError, response.Content)
		}
		if wantError {
			return MediaResult{}
		}
		raw, _ := json.Marshal(response.StructuredContent)
		var media MediaResult
		if err := json.Unmarshal(raw, &media); err != nil {
			t.Fatal(err)
		}
		return media
	}
	still := call("bailian_image_generate", map[string]any{"prompt": "example", "size": "1024x1024"}, false)
	if still.Resolution != "1024*1024" || still.URL == "" {
		t.Fatal(still)
	}
	f := call("bailian_video_frames", map[string]any{"prompt": "transition", "first_frame": "https://example.org/f.png", "last_frame": "https://example.org/l.png", "resolution": "480p", "duration": 7}, false)
	if f.Model != "wan3.0-video-prime" || !f.Fallback || f.Duration != 7 || f.Resolution != "480P" || f.Job == "" {
		t.Fatal(f)
	}
	done := call("bailian_video_status", map[string]any{"job": f.Job}, false)
	if done.Status != "SUCCEEDED" || !strings.HasSuffix(done.URL, ".mp4") {
		t.Fatal(done)
	}
	call("bailian_video_status", map[string]any{"job": f.Job + "bad"}, true)
	call("bailian_video_text", map[string]any{"prompt": "test", "duration": 0}, true)
	call("bailian_video_first", map[string]any{"prompt": "test", "first_frame": "https://127.0.0.1/a", "duration": 4}, true)
	call("bailian_video_frames", map[string]any{"prompt": "test", "first_frame": "https://example.org/a", "last_frame": "https://example.org/b", "reference_images": []string{"https://example.org/c"}}, true)
	call("bailian_video_reference", map[string]any{"prompt": "test", "reference_images": []string{"https://example.org/a"}, "duration": 31}, true)
	call("bailian_video_reference", map[string]any{"prompt": "test", "reference_images": []string{"https://example.org/a", "https://example.org/b"}, "resolution": "1080P", "duration": 8}, false)
	mux.Lock()
	defer mux.Unlock()
	if len(submissions) != 5 {
		t.Fatalf("submissions=%d", len(submissions))
	}
	for _, request := range submissions[1:3] {
		input := request["input"].(map[string]any)
		items := input["media"].([]any)
		if len(items) != 2 || items[0].(map[string]any)["type"] != "first_frame" || items[1].(map[string]any)["type"] != "last_frame" {
			t.Fatal(items)
		}
		parameters := request["parameters"].(map[string]any)
		if parameters["duration"] != float64(7) || parameters["resolution"] != "480P" {
			t.Fatal(parameters)
		}
	}
}

func TestUncertainSubmissionDoesNotRetry(t *testing.T) {
	var attempts int
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		attempts++
		w.WriteHeader(503)
		_, _ = w.Write([]byte(`{"code":"ModelNotFound"}`))
	}))
	defer provider.Close()
	service := &service{key: "test", native: provider.URL, client: provider.Client()}
	_, err := service.video(context.Background(), "text", VideoOptions{Prompt: "example"}, nil)
	if err == nil || attempts != 1 {
		t.Fatalf("attempts=%d err=%v", attempts, err)
	}
}
