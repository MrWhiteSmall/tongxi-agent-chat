package main

import (
	"context"
	"crypto/subtle"
	"errors"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func addTool[T any](server *mcp.Server, name, description string, invoke func(context.Context, T) (MediaResult, error)) {
	mcp.AddTool(server, &mcp.Tool{Name: name, Description: description},
		func(ctx context.Context, _ *mcp.CallToolRequest, args T) (*mcp.CallToolResult, MediaResult, error) {
			result, err := invoke(ctx, args)
			return nil, result, err
		})
}

func newMCP(s *service) *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{Name: "tongxi-bailian-media", Version: "1.0.0"}, nil)
	addTool(server, "bailian_image_generate", "Generate one new image from text without reference images. Charges may apply.",
		func(ctx context.Context, args ImageOptions) (MediaResult, error) {
			return s.image(ctx, args, nil)
		})
	addTool(server, "bailian_image_edit", "Edit one or more existing images, including changing framing or retaining the same subject. Requires images. Charges may apply.",
		func(ctx context.Context, args ImageEdit) (MediaResult, error) {
			if err := validateImages(args.Images, 1, 3); err != nil {
				return MediaResult{}, err
			}
			return s.image(ctx, args.ImageOptions, args.Images)
		})
	addTool(server, "bailian_video_text", "Generate a video solely from text when the user did not provide or require a reference image. Returns a job to poll. Charges may apply.",
		func(ctx context.Context, args VideoOptions) (MediaResult, error) {
			return s.video(ctx, "text", args, nil)
		})
	addTool(server, "bailian_video_first", "Generate motion from one exact opening image. The source image becomes the opening frame. Returns a job to poll. Charges may apply.",
		func(ctx context.Context, args FirstFrameVideo) (MediaResult, error) {
			return s.video(ctx, "first", args.VideoOptions, []media{{"first_frame", args.First}})
		})
	addTool(server, "bailian_video_frames", "Generate a transition between explicitly designated first and last images. Additional reference images cannot be used in this mode. Returns a job to poll. Charges may apply.",
		func(ctx context.Context, args FramePairVideo) (MediaResult, error) {
			return s.video(ctx, "frames", args.VideoOptions, []media{{"first_frame", args.First}, {"last_frame", args.Last}})
		})
	addTool(server, "bailian_video_reference", "Generate a video with one or more ordered subject or scene references without forcing opening or closing frames. Refer to them as 图1, 图2. Returns a job to poll. Charges may apply.",
		func(ctx context.Context, args ReferenceVideo) (MediaResult, error) {
			if len(args.References) == 0 {
				return MediaResult{}, errors.New("参考生视频至少需要一张参考图")
			}
			items := make([]media, 0, len(args.References))
			for _, item := range args.References {
				items = append(items, media{"reference_image", item})
			}
			return s.video(ctx, "reference", args.VideoOptions, items)
		})
	addTool(server, "bailian_video_status", "Read an existing video job without submitting another generation.",
		func(ctx context.Context, args struct {
			Job string `json:"job" jsonschema:"Opaque job ticket from video submission"`
		}) (MediaResult, error) {
			return s.videoStatus(ctx, args.Job)
		})
	return server
}

func httpHandler(server *mcp.Server, token string) http.Handler {
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server },
		&mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true, MaxRequestBodyBytes: 32 << 20})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/mcp" {
			http.NotFound(w, r)
			return
		}
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		handler.ServeHTTP(w, r)
	})
}

func main() {
	key := os.Getenv("DASHSCOPE_API_KEY")
	if key == "" {
		key = os.Getenv("QWEN_API_KEY")
	}
	if key == "" {
		log.Fatal("DASHSCOPE_API_KEY is required")
	}
	endpoint := os.Getenv("DASHSCOPE_HTTP_BASE_URL")
	if endpoint == "" {
		endpoint = "https://dashscope.aliyuncs.com/api/v1"
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		log.Fatal("DASHSCOPE_HTTP_BASE_URL must be an HTTPS base URL")
	}
	token := os.Getenv("BAILIAN_MCP_TOKEN")
	secret := token
	if secret == "" {
		secret = key
	}
	s := &service{key: key, native: strings.TrimRight(endpoint, "/"), secret: []byte(secret),
		client: &http.Client{Timeout: 120 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	server := newMCP(s)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	addr := os.Getenv("BAILIAN_MCP_ADDR")
	if addr == "" {
		if err := server.Run(ctx, &mcp.StdioTransport{}); err != nil && ctx.Err() == nil {
			log.Fatal(err)
		}
		return
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil || (host != "127.0.0.1" && host != "::1") || len(token) < 32 {
		log.Fatal("HTTP requires a loopback BAILIAN_MCP_ADDR and BAILIAN_MCP_TOKEN (32+ characters)")
	}
	h := &http.Server{Addr: addr, Handler: httpHandler(server, token), ReadHeaderTimeout: 6 * time.Second, ReadTimeout: 40 * time.Second, WriteTimeout: 145 * time.Second, IdleTimeout: 30 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		_ = h.Shutdown(shutdown)
	}()
	log.Printf("Media MCP on %s", addr)
	if err := h.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
