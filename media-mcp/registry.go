package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

const maxImageBytes = 10_000_000

type ImageOptions struct {
	Prompt string `json:"prompt" jsonschema:"Prompt describing the new image or requested changes"`
	Size   string `json:"size,omitempty" jsonschema:"Output dimensions e.g. 1024x1024; defaults to automatic"`
	Model  string `json:"model,omitempty" jsonschema:"qwen-image-2.1-turbo or qwen-image-2.1-pro; omitted lets the service select"`
}

type ImageEdit struct {
	ImageOptions
	Images []string `json:"images" jsonschema:"One to three HTTPS image URLs or image data URLs"`
}

type VideoOptions struct {
	Prompt     string `json:"prompt" jsonschema:"Scene and motion description"`
	Resolution string `json:"resolution,omitempty" jsonschema:"480P 720P or 1080P; defaults to 720P"`
	Duration   *int   `json:"duration,omitempty" jsonschema:"Duration in whole seconds from 2 to 30; defaults to 5"`
	Ratio      string `json:"ratio,omitempty" jsonschema:"adaptive or an aspect ratio such as 16:9 or 9:16"`
	Model      string `json:"model,omitempty" jsonschema:"Optional compatible model ID; defaults to an appropriate Wan model"`
}

type FirstFrameVideo struct {
	VideoOptions
	First string `json:"first_frame" jsonschema:"The exact opening image as HTTPS URL or image data URL"`
}

type FramePairVideo struct {
	VideoOptions
	First string `json:"first_frame" jsonschema:"The exact opening image as HTTPS URL or image data URL"`
	Last  string `json:"last_frame" jsonschema:"The exact closing image as HTTPS URL or image data URL"`
}

type ReferenceVideo struct {
	VideoOptions
	References []string `json:"reference_images" jsonschema:"One to ten reference images; ordering defines 图1 图2 and so on; these are not forced frames"`
}

type media struct {
	Type string `json:"type"`
	URL  string `json:"url"`
}

type videoModelProfile struct {
	name        string
	modes       string
	maxDuration int
	resolutions string
	wire        string
}

var videoModels = []videoModelProfile{
	{"wan3.0-video", "text first frames reference", 30, "480P 720P 1080P", "media"},
	{"wan3.0-video-prime", "text first frames reference", 30, "480P 720P 1080P", "media"},
	{"wan2.7-t2v", "text", 15, "720P 1080P", "text"},
	{"wan2.6-i2v-flash", "first", 15, "720P 1080P", "legacy-first"},
}

func listed(values, item string) bool {
	for _, value := range strings.Fields(values) {
		if value == item {
			return true
		}
	}
	return false
}

func validatePrompt(prompt string) error {
	if strings.TrimSpace(prompt) == "" || utf8.RuneCountInString(prompt) > 6000 {
		return errors.New("提示词须为 1–6000 字")
	}
	return nil
}

var imageDimensions = regexp.MustCompile(`^([0-9]{1,4})[xX*×]([0-9]{1,4})$`)

func imageSize(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	match := imageDimensions.FindStringSubmatch(strings.TrimSpace(value))
	if match == nil {
		return "", errors.New("图片尺寸应为宽×高，例如 1024x1024")
	}
	width, _ := strconv.Atoi(match[1])
	height, _ := strconv.Atoi(match[2])
	area := width * height
	if width < 1 || height < 1 || width > 8*height || height > 8*width || area < 512*512 || area > 2048*2048 {
		return "", errors.New("图片像素面积须在 512×512 至 2048×2048 之间，宽高比为 1:8 至 8:1")
	}
	return fmt.Sprintf("%d*%d", width, height), nil
}

func validateImage(value string) error {
	if strings.HasPrefix(value, "data:") {
		header, encoded, ok := strings.Cut(value, ",")
		if !ok || !listed("data:image/png;base64 data:image/jpeg;base64 data:image/webp;base64 data:image/gif;base64", header) ||
			len(encoded) == 0 || len(encoded) > base64.StdEncoding.EncodedLen(maxImageBytes-1) {
			return errors.New("图片须为有效的 PNG、JPEG、WebP 或 GIF，且小于 10 MB")
		}
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(decoded) == 0 || len(decoded) >= maxImageBytes {
			return errors.New("图片 Base64 无效或超出限制")
		}
		mediaType := strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64")
		matches := map[string]bool{
			"image/png":  bytes.HasPrefix(decoded, []byte("\x89PNG\r\n\x1a\n")),
			"image/jpeg": bytes.HasPrefix(decoded, []byte{255, 216, 255}),
			"image/gif":  bytes.HasPrefix(decoded, []byte("GIF87a")) || bytes.HasPrefix(decoded, []byte("GIF89a")),
			"image/webp": len(decoded) >= 12 && bytes.HasPrefix(decoded, []byte("RIFF")) && bytes.Equal(decoded[8:12], []byte("WEBP")),
		}
		if !matches[mediaType] {
			return errors.New("图片字节与声明格式不一致")
		}
		return nil
	}
	u, err := url.Parse(value)
	if len(value) > 8192 || err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.Hostname() == "" {
		return errors.New("图片须为有效的 HTTPS URL 或图片数据 URL")
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	ip := net.ParseIP(host)
	if (ip != nil && (!ip.IsGlobalUnicast() || ip.IsPrivate())) || !strings.Contains(host, ".") ||
		strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") || strings.HasSuffix(host, ".localhost") {
		return errors.New("图片 URL 须使用可访问的公网 HTTPS 地址")
	}
	return nil
}

func validateImages(images []string, min, max int) error {
	if len(images) < min || len(images) > max {
		return fmt.Errorf("需要 %d–%d 张图片，收到 %d 张", min, max, len(images))
	}
	encodedSize := 0
	for _, value := range images {
		if err := validateImage(value); err != nil {
			return err
		}
		if strings.HasPrefix(value, "data:") {
			encodedSize += len(value)
		}
	}
	if encodedSize > 28_000_000 {
		return errors.New("内嵌图片合计过大，请改用授权图片 URL")
	}
	return nil
}

func normalizeVideo(options VideoOptions, mode string) (VideoOptions, []videoModelProfile, error) {
	if err := validatePrompt(options.Prompt); err != nil {
		return options, nil, err
	}
	options.Resolution = strings.ToUpper(strings.TrimSpace(options.Resolution))
	if options.Resolution == "" {
		options.Resolution = "720P"
	}
	if options.Duration == nil {
		value := 5
		options.Duration = &value
	}
	if options.Ratio == "" {
		if mode == "text" {
			options.Ratio = "16:9"
		} else {
			options.Ratio = "adaptive"
		}
	}
	if !listed("480P 720P 1080P", options.Resolution) || *options.Duration < 2 || *options.Duration > 30 ||
		!listed("21:9 16:9 4:3 1:1 3:4 9:16 adaptive", options.Ratio) {
		return options, nil, errors.New("分辨率须为 480P、720P 或 1080P，时长为 2–30 秒，宽高比须为有效档位")
	}
	order := []string{"wan3.0-video", "wan3.0-video-prime", "wan2.7-t2v"}
	if mode == "first" {
		order = []string{"wan2.6-i2v-flash", "wan3.0-video", "wan3.0-video-prime"}
	}
	if options.Model != "" {
		order = []string{options.Model}
	}
	var candidates []videoModelProfile
	for _, name := range order {
		for _, model := range videoModels {
			ratioOK := (model.wire != "legacy-first" || options.Ratio == "adaptive") &&
				(model.wire != "text" || listed("16:9 9:16 1:1 4:3 3:4", options.Ratio))
			if model.name == name && listed(model.modes, mode) && *options.Duration <= model.maxDuration &&
				listed(model.resolutions, options.Resolution) && ratioOK {
				candidates = append(candidates, model)
			}
		}
	}
	if len(candidates) == 0 {
		return options, nil, errors.New("没有模型支持指定的素材模式、分辨率、时长和宽高比")
	}
	return options, candidates, nil
}
