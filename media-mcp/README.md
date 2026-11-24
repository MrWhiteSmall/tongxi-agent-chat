# 同席百炼媒体 MCP

Go 1.25+，使用官方 Go MCP SDK。运行 `go test -race ./...` 验证 MCP 协议、七个工具的发现、请求格式、同规格兜底、失败校验与视频状态查询。

```sh
go build -trimpath -o tongxi-media-mcp .
```

运行前通过启动环境提供北京区计量型 `DASHSCOPE_API_KEY`。默认传输为 stdio，可由支持 MCP 的客户端启动本二进制。需要给同席调用时，设置 `BAILIAN_MCP_ADDR=127.0.0.1:4319` 和至少 32 字符的 `BAILIAN_MCP_TOKEN`，服务提供带 Bearer 鉴权的 `/mcp`。自定义百炼工作空间可设置 `DASHSCOPE_HTTP_BASE_URL`。部署单元见 `../scripts/ecs/tongxi-media-mcp.service`。同席需配置 `BAILIAN_MCP_URL=http://127.0.0.1:4319/mcp` 与相同的 MCP 令牌。

| 工具 | 素材 | 模型 |
| --- | --- | --- |
| `bailian_image_generate` | 文字 | Qwen Image 2.1 Turbo / Pro |
| `bailian_image_edit` | 文字与 1–3 张图 | Qwen Image 2.1 Turbo / Pro |
| `bailian_video_text` | 文字 | Wan 3.0 Video / Prime、Wan 2.7 T2V |
| `bailian_video_first` | 一张首帧 | Wan 2.6 I2V Flash、Wan 3.0 Video / Prime |
| `bailian_video_frames` | 独立指定首帧、尾帧 | Wan 3.0 Video / Prime |
| `bailian_video_reference` | 1–10 张参考图，按数组顺序编号 | Wan 3.0 Video / Prime |
| `bailian_video_status` | 视频提交返回的签名任务凭证 | 查询原任务 |

图片可指定 `size`，如 `1024x1024`。像素面积必须在 512×512 至 2048×2048 之间，宽高比为 1:8 至 8:1。视频接受 `resolution`、`duration`、`ratio` 和可选 `model`。时长全局范围为 2–30 秒，具体模型、分辨率与宽高比再做交集校验。省略时默认 720P、5 秒。内嵌图片每张小于 10 MB，Base64 总量最多 28 MB。严格首尾帧与额外参考图互斥。

未指定模型时，服务只在提供商明确返回模型不可用、且备选完整支持原素材和参数时切换模型。超时、网络失败、限流、泛化服务端错误和已接单后的失败均保留原错误，避免重复生成或计费。视频提交返回可跨服务重启查询的签名凭证。扩展通常需要为 `registry.go` 增加模型规格，或者在 `main.go` 登记新工具、添加对应的百炼请求序列化和测试。

相关文档：[百炼图片 API](https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference) · [万相 3.0 素材组合](https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference) · [Go MCP SDK](https://github.com/modelcontextprotocol/go-sdk)

示例 MCP 客户端配置（路径换成本地二进制；从启动环境注入 API Key）：

```json
{
  "mcpServers": {
    "tongxi-media": {
      "command": "/path/to/tongxi-media-mcp"
    }
  }
}
```
