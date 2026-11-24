package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

type service struct {
	key    string
	native string
	secret []byte
	client *http.Client
}

type providerResult struct {
	Code   string `json:"code"`
	Output struct {
		ID        string `json:"task_id"`
		Status    string `json:"task_status"`
		VideoURL  string `json:"video_url"`
		ErrorCode string `json:"code"`
		Choices   []struct {
			Message struct {
				Content []struct {
					Image string `json:"image"`
				} `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	} `json:"output"`
}

type providerError struct {
	status int
	code   string
}

func (e *providerError) Error() string {
	return fmt.Sprintf("百炼请求失败（HTTP %d；%s）", e.status, e.code)
}

func unavailableModel(err error) bool {
	var fault *providerError
	return errors.As(err, &fault) && (fault.status == 400 || fault.status == 403 || fault.status == 404) &&
		listed("InvalidModel ModelNotFound ModelNotSupported ModelAccessDenied AccessDenied.Model ModelNotAvailable", fault.code)
}

var providerCode = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,70}$`)

func (s *service) request(ctx context.Context, path string, payload any, async bool) (providerResult, error) {
	var output providerResult
	method := http.MethodGet
	var reader io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return output, err
		}
		method, reader = http.MethodPost, bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, s.native+path, reader)
	if err != nil {
		return output, err
	}
	req.Header.Set("Authorization", "Bearer "+s.key)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if async {
		req.Header.Set("X-DashScope-Async", "enable")
	}
	res, err := s.client.Do(req)
	if err != nil {
		return output, errors.New("百炼网络请求未完成")
	}
	defer res.Body.Close()
	decodeErr := json.NewDecoder(io.LimitReader(res.Body, 2<<20)).Decode(&output)
	if res.StatusCode < 200 || res.StatusCode >= 300 || output.Code != "" {
		if !providerCode.MatchString(output.Code) {
			output.Code = "unknown"
		}
		return output, &providerError{res.StatusCode, output.Code}
	}
	if decodeErr != nil {
		return output, errors.New("百炼返回的数据无法解析")
	}
	return output, nil
}

type MediaResult struct {
	Kind       string `json:"kind"`
	Mode       string `json:"mode"`
	Model      string `json:"model"`
	Status     string `json:"status"`
	URL        string `json:"url,omitempty"`
	Job        string `json:"job,omitempty"`
	Resolution string `json:"resolution,omitempty"`
	Duration   int    `json:"duration,omitempty"`
	Error      string `json:"error,omitempty"`
	Fallback   bool   `json:"fallback,omitempty"`
}

func validHTTPS(raw string) bool {
	return strings.HasPrefix(raw, "https://") && validateImage(raw) == nil
}

func (s *service) image(ctx context.Context, options ImageOptions, images []string) (MediaResult, error) {
	if err := validatePrompt(options.Prompt); err != nil {
		return MediaResult{}, err
	}
	size, err := imageSize(options.Size)
	if err != nil {
		return MediaResult{}, err
	}
	models := []string{"qwen-image-2.1-turbo", "qwen-image-2.1-pro"}
	if options.Model != "" {
		if !listed(strings.Join(models, " "), options.Model) {
			return MediaResult{}, errors.New("当前图片工具不支持指定模型")
		}
		models = []string{options.Model}
	}
	mode := "text"
	if len(images) != 0 {
		mode = "edit"
	}
	content := make([]map[string]string, 0, len(images)+1)
	for _, image := range images {
		content = append(content, map[string]string{"image": image})
	}
	prompt := options.Prompt
	if mode == "edit" {
		prompt = "基于提供的原图编辑，保留未要求改变的特征：" + prompt
	}
	content = append(content, map[string]string{"text": prompt})
	parameters := map[string]any{"n": 1}
	if size != "" {
		parameters["size"] = size
	}
	var last error
	for index, model := range models {
		reply, err := s.request(ctx, "/services/aigc/multimodal-generation/generation", map[string]any{
			"model": model, "parameters": parameters,
			"input": map[string]any{"messages": []any{map[string]any{"role": "user", "content": content}}},
		}, false)
		if err != nil {
			if unavailableModel(err) {
				last = err
				continue
			}
			return MediaResult{}, err
		}
		for _, choice := range reply.Output.Choices {
			for _, part := range choice.Message.Content {
				if validHTTPS(part.Image) {
					return MediaResult{Kind: "image", Mode: mode, Model: model, Status: "SUCCEEDED", URL: part.Image, Resolution: size, Fallback: index > 0}, nil
				}
			}
		}
		return MediaResult{}, errors.New("百炼没有返回可打开的图片")
	}
	return MediaResult{}, last
}

var remoteID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)

type job struct {
	ID      string      `json:"id"`
	Expires int64       `json:"expires"`
	Result  MediaResult `json:"result"`
}

func (s *service) signature(payload string) []byte {
	mac := hmac.New(sha256.New, s.secret)
	_, _ = mac.Write([]byte(payload))
	return mac.Sum(nil)
}

func (s *service) ticket(id string, result MediaResult) string {
	bytes, _ := json.Marshal(job{ID: id, Expires: time.Now().Add(23 * time.Hour).Unix(), Result: result})
	payload := base64.RawURLEncoding.EncodeToString(bytes)
	return payload + "." + base64.RawURLEncoding.EncodeToString(s.signature(payload))
}

func (s *service) readTicket(ticket string) (job, error) {
	var j job
	payload, signature, ok := strings.Cut(ticket, ".")
	provided, err := base64.RawURLEncoding.DecodeString(signature)
	if len(ticket) > 2048 || !ok || err != nil || !hmac.Equal(provided, s.signature(payload)) {
		return j, errors.New("无效的视频任务凭证")
	}
	bytes, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil || json.Unmarshal(bytes, &j) != nil || !remoteID.MatchString(j.ID) || j.Expires <= time.Now().Unix() {
		return j, errors.New("无效或已过期的视频任务凭证")
	}
	return j, nil
}

func (s *service) video(ctx context.Context, mode string, options VideoOptions, assets []media) (MediaResult, error) {
	options, candidates, err := normalizeVideo(options, mode)
	if err != nil {
		return MediaResult{}, err
	}
	values := make([]string, 0, len(assets))
	for _, asset := range assets {
		values = append(values, asset.URL)
	}
	if len(values) != 0 {
		if err := validateImages(values, 1, 10); err != nil {
			return MediaResult{}, err
		}
	}
	var last error
	for index, model := range candidates {
		parameters := map[string]any{"resolution": options.Resolution, "duration": options.Duration}
		input := map[string]any{"prompt": options.Prompt}
		if model.wire == "legacy-first" {
			input["img_url"] = assets[0].URL
		} else {
			parameters["ratio"] = options.Ratio
			if len(assets) != 0 {
				input["media"] = assets
			}
		}
		reply, err := s.request(ctx, "/services/aigc/video-generation/video-synthesis", map[string]any{
			"model": model.name, "input": input, "parameters": parameters,
		}, true)
		if err != nil {
			if unavailableModel(err) {
				last = err
				continue
			}
			return MediaResult{}, err
		}
		if !remoteID.MatchString(reply.Output.ID) {
			return MediaResult{}, errors.New("百炼未返回有效的视频任务编号")
		}
		result := MediaResult{Kind: "video", Mode: mode, Model: model.name, Status: "PENDING", Resolution: options.Resolution, Duration: *options.Duration, Fallback: index > 0}
		result.Job = s.ticket(reply.Output.ID, result)
		return result, nil
	}
	return MediaResult{}, last
}

func (s *service) videoStatus(ctx context.Context, ticket string) (MediaResult, error) {
	j, err := s.readTicket(ticket)
	if err != nil {
		return MediaResult{}, err
	}
	reply, err := s.request(ctx, "/tasks/"+j.ID, nil, false)
	if err != nil {
		return MediaResult{}, err
	}
	result := j.Result
	result.Status = reply.Output.Status
	switch result.Status {
	case "PENDING", "QUEUED", "RUNNING":
		result.Job = ticket
	case "SUCCEEDED":
		if !validHTTPS(reply.Output.VideoURL) {
			return MediaResult{}, errors.New("百炼未返回可打开的视频")
		}
		result.URL = reply.Output.VideoURL
	case "FAILED", "CANCELED", "CANCELLED", "UNKNOWN":
		code := reply.Output.ErrorCode
		if !providerCode.MatchString(code) {
			code = result.Status
		}
		result.Error = "百炼视频任务未完成（" + code + "）"
	default:
		return MediaResult{}, errors.New("百炼返回了未知视频任务状态")
	}
	return result, nil
}
