# 同席 · Agent Chat

本地聊天原型。真人私聊或群聊可以临时邀请 Agent，在自己的独立 AI 团队里可以把任务交给一组 Agent。手机浏览器和 macOS 桌面应用使用同一个界面。

## 本机开箱

1. 解压 `dist/Tongxi-mac-arm64.zip`，打开 `Tongxi.app`。适用于 Apple Silicon Mac。签名是本地 ad-hoc 签名，安装包未公证。
2. 本机演示账号是 `A` 到 `E`，无需登录码。点击「新建会话」建立私聊、群聊或独立 AI 团队。也可在同一台机器的两个浏览器标签页打开桌面的本地服务地址，分别登录 A、B。
3. 桌面程序读取本机交互式 zsh 的环境变量。存在 `DEEPSEEK_API_KEY` 时，默认目录加入 DeepSeek、制作助手、审校助手。如果没有配置可用的模型 API，仍可用「离线示例」体验预览。macOS 应用数据保存在系统「应用程序支持」目录的 Tongxi 文件夹。

源码启动浏览器版需要 Node.js 24+，本机存储模式无需安装 OSS 依赖，服务器存储模式先运行 `npm ci --omit=dev`。

```sh
zsh -ic 'node server.mjs'
```

在浏览器打开 `http://127.0.0.1:4317`。同一时刻只运行一个进程写同一份 SQLite 数据。用不同的浏览器窗口或标签页分别登录 A、B。双人聊天、群聊和私有团队都支持文本以及严格小于 10 MB 的附件（10 MB = 10,000,000 字节）。服务器附件写入私有 OSS，桌面或本地模式写入数据目录。。

## Agent

| Agent | 后端 | 启用条件 |
| --- | --- | --- |
| DeepSeek、制作助手、审校助手 | 同席 Agent 运行时，默认使用 `deepseek-flash` 推理 | `DEEPSEEK_API_KEY`。制作和审校在仅配置 Qwen 时可用 Qwen。 |
| Qwen | 同席 Agent 运行时，默认使用 `qwen4-max` 推理 | `DASHSCOPE_API_KEY` 或 `QWEN_API_KEY`，按地域或工作空间配置 `QWEN_BASE_URL`，可用 `QWEN_MODEL` 改模型。 |
| Codex | 本机已登录的 Codex CLI | 桌面自动探测，需要本机登录。浏览器版用 `ENABLE_CODEX=1`。 |
| Claude | 本机 Claude Code，沿用本机可用的授权 | 桌面探测，浏览器版用 `ENABLE_CLAUDE=1`。 |
| PiAgent | 本机 Pi，使用配置的推理后端 | 有 DeepSeek API Key 时桌面默认选 `deepseek/deepseek-flash`，也可设 `PI_MODEL`。 |
| DeepSeek Harness | 本机已配置的 `dsh` ACP，或自建 HTTP 服务 | 桌面探测。浏览器版用 `ENABLE_DSH=1` 或 `DEEPSEEKHARNESS_URL`。 |
| Mastra、OhMyGame、CrewAI | 自建 HTTP Agent 服务 | 配置 `MASTRA_URL`、`OHMYGAME_URL`、`CREWAI_URL`。 |

平台将当前任务、已授权的消息和附件编号交给运行时，并给每个任务创建一个独立的 MCP 工具入口。运行时读取工具目录，自行决定何时调用、是否继续、如何组合工具及向哪个获准的会话成员分派子任务。平台校验授权、并发和调用次数，并将 Agent 选择交付的媒体渲染成卡片。单文件 HTML 仍通过沙箱预览。

HTTP Agent 适配器接收 `{"system":"角色指令","input":"授权的任务上下文","tools":{"type":"streamable-http","url":"当前任务的私有入口"}}`，返回 `{"text":"最终回复"}`。对应的 `_TOKEN` 用于认证运行时。运行时在其任务内使用传入的 MCP 地址，地址在任务结束后失效，禁止写入聊天或日志。默认通过回环访问；跨主机可配置 `CHAT_AGENT_TOOLS_ORIGIN` 指向运行时能够访问的私有监听入口。公共 Nginx 禁止访问 `/internal/`。

敏感凭据由服务进程读取，浏览器和分发包无需携带密钥。私聊或群聊邀请 Agent 默认只共享发出的消息，可改选「最近 12 条」或手选历史。把会话文字转发到私有 AI 团队后，再用团队消息发起任务。产物预览使用独立来源的沙箱，用户可下载 HTML 或明确分享给目标会话。

- [设计计划](docs/DESIGN.md)
- [五人内部部署与成本](docs/DEPLOYMENT.md)

`npm test` 验证多人会话、Agent 加入和退出、子任务、隐私、文件、分享、取消与恢复。`npm ci` 后运行 `npm run package:mac` 构建当前架构的 macOS 包。

复制截图、图片或浏览器可读取的文件后，在输入框粘贴即可加入待发送附件，点击「发送」后上传。每条消息最多四份文件，合计不超过 18 MB。已上传的图片可随当前消息交给 DeepSeek Flash，也可通过「选择历史」明确授权分享已有图片。普通视觉聊天最多传两张、合计不超过 10 MB，媒体 MCP 支持更多参考图。

真人和 Agent 的消息均可使用 Markdown。聊天气泡支持标题、列表、引用、表格和代码块。外部图片语法显示为可点击的图片链接，粘贴或上传的图片仍通过附件发送。

配置百炼 API Key 后，Agent 可以调用联网搜索、文搜图等工具。引用上一条生成结果、附图或从历史中勾选消息，都可以将相应素材授权给 Agent。遇到「这个」或「刚才那张」等指代时，引用原消息能提供明确上下文。原图链接过期后可重新上传。

聊天里的图片、视频、音频和普通附件以预览卡片呈现。图片支持缩略图与放大，视频和音频可点卡片播放，文本附件可快速预览，其他格式通过卡片下载。百炼媒体卡片使用服务返回的限时原件。

百炼生图、改图和视频可通过 [Go 媒体 MCP](media-mcp/README.md) 执行。Agent 从 MCP 工具目录选择生成方式，并通过任务内的图片编号指定参考素材。任务面板显示状态及取消入口。可以直接发「@cc 用图 1 作首帧、图 2 作尾帧，生成 5 秒 720p 视频」「@DeepSeek 参考图 1 的人物和图 2 的场景，生成 5 秒视频」或「@cc 画一只橙色小鸟，尺寸 1024×768」。

Android 内测 APK 复用同席移动网页，连接当前 HTTPS 内测服务。安装后使用原账号登录。外部链接由系统浏览器打开，登录、消息和 Agent 任务依赖服务器联网。

安装 Android SDK Platform 36、Build Tools 36.1.0 和 JDK 后，运行 `scripts/package-android.sh`，产物在 `dist/Tongxi-android.apk`。默认使用本机 Android 调试签名供内测，同包名覆盖更新需保留原签名。自有签名可设置 `TONGXI_ANDROID_KEYSTORE`、`TONGXI_ANDROID_KEY_ALIAS` 和 `TONGXI_ANDROID_KEYSTORE_PASSWORD`（接受 apksigner 的 `env:`、`file:` 等密码来源）。

Android 登录后可允许系统通知。「新聊天消息」频道用于后台和锁屏提醒，声音和震动跟随系统设置。内测版通过后台服务每 5 秒查询一次；后台连接通知会在通知栏显示。强行停止应用、从最近任务移除或系统停止服务后，需要重新打开同席才能恢复提醒。

同一浏览器或 Android 设备会记住登录状态，重新打开后自动恢复。手动退出会通过服务器撤销当前会话。

Android 返回手势会依次关闭当前弹层、回到消息首页、返回桌面。
