# 五人内部部署

**建议从 2 vCPU、2 GB RAM、20 GB SSD 起步。** 假设五人以内，普通消息和产物预览由此应用处理，模型推理通过 DeepSeek 或百炼 API，机器不跑本地大模型，因此无需 GPU。已有 Linux 机器时，可以先分配 **1 vCPU、1 GB RAM、10 GB SSD** 验证。若还要在同机运行多个 Agent 框架、浏览器或构建工作区，从 **4 vCPU、8 GB RAM、40 GB SSD** 开始，按工作流测量。第三方 CLI 运行时不随 Linux 服务包启动。

本机实测服务进程在两位用户聊天与短 Agent 任务下约几十到 85 MB RSS。该数字不含反代、操作系统和 Agent 进程。当前版本按 SQLite 快照保存，适合小组使用。单个附件严格小于 10 MB（10,000,000 字节），服务器模式将新附件写入私有 OSS。SQLite 保存会话及附件索引，文件内容占用 OSS 存储。长时间保留大量会话时，需要增加归档策略或拆分数据库表。

## 启动

准备 Node.js 24+ 和一个专用 Linux 用户。令环境文件仅部署账号可读，例如 `chmod 600 /etc/tongxi.env`。下面的值是配置格式示例，部署时生成随机登录码并填写自己的 API Key。

```dotenv
CHAT_LOCAL=0
CHAT_HOST=127.0.0.1
PORT=4317
CHAT_DATA=/var/lib/tongxi
CHAT_ACCOUNTS='{"A":"替换为每人独立的随机登录码","B":"替换为另一个随机登录码"}'
DEEPSEEK_API_KEY=填入团队API密钥
OSS_BUCKET=你的私有桶
OSS_REGION=oss-cn-shanghai
OSS_ENDPOINT=https://oss-cn-shanghai-internal.aliyuncs.com
OSS_ACCESS_KEY_ID=仅授权目标桶附件前缀的专用RAM用户
OSS_ACCESS_KEY_SECRET=填入对应密钥
```

```sh
npm ci --omit=dev
node --env-file=/etc/tongxi.env server.mjs
```

前面使用现有 HTTPS 反向代理或内网 VPN，把手机浏览器和桌面浏览器引向同一个地址。保持 Node 服务只监听 127.0.0.1，防火墙限制入口。用 systemd 或容器重启策略维持后台运行。账号限制为 1–15 个，每人用独立且至少 16 字符的随机登录码。SQLite 数据包含聊天正文和产物，关闭服务后备份数据目录，或使用 SQLite 在线备份功能。修改登录码后，如需令此前会话马上失效，轮换账号名或在停机时清理会话记录。

服务器模式不会启动 Codex、Claude、Dsh、Pi 的本机 CLI。内部用户共享团队的 DeepSeek/Qwen API 配额。远程框架端点仅由部署者在环境文件配置。

## 模型用量估算

假设五人每人每个工作日用 20 次 Agent，一个月按 22 个工作日，约 **2,200 个任务**。每个任务平均 2,000 输入和 500 输出 token，则约 440 万输入、110 万输出。按 DeepSeek Flash 缓存未命中高峰价 $0.30／$1.20 每百万 token，模型费约 **$2.64/月**。低峰按现价约 **$1.32/月**。若大量使用多 Agent、反复生成代码和长上下文，总 token 达上述假设的 3–10 倍，高峰估算 **$7.92–$26.40/月**，加上主机费用。实例地域和供应商决定具体机器报价。 [DeepSeek 官方定价](https://api-docs.deepseek.com/quick_start/pricing/)

Qwen 模型 ID 与工作空间配置参考 [百炼兼容接口](https://help.aliyun.com/en/model-studio/compatibility-of-openai-with-dashscope)。生产计费以所选模型、地域和实时用量为准。

## 上海 ECS 部署配置

部署使用同地域 OSS 内网端点与私有桶，专用 RAM 用户仅拥有附件前缀的写入和读取权限。浏览器通过应用读取附件，下载前校验账号和会话成员关系。Nginx 的独立 HTTPS 端口 9443 与同服务器的其他应用隔离浏览器来源。应用后端仅监听回环，systemd 单元设置 300 MB 内存软限、400 MB 硬限。

备份时同时保留 SQLite 和 OSS 对象。部署资源模板在 `scripts/ecs`。安装 Nginx 示例前，替换示例域名和 TLS 证书路径。账户登录码保存在服务器权限受限的环境文件中，分发给对应成员即可。

内测实例每天北京时间 04:00 通过 `tongxi-cleanup.timer` 清空聊天消息、任务及其可运行产物，删除同席记录的 OSS 附件。账号、会话和成员设置保留。OSS 专用账号需额外拥有同一附件前缀的删除权限。清理过程暂时拒绝写请求，失败后定时重试，同日重试仅处理未删附件。内测请勿使用此实例长期存放需要保留的内容。

可选编码 Agent 工作者运行在独立系统账号下，监听回环地址 4318。安装 Codex CLI、Claude Code 和 Pi CLI 到 `/opt/tongxi/agent-cli`，配置 `/etc/tongxi/agents.env` 中的 DeepSeek API 和工作者令牌，再启用 `tongxi-agent-worker.service`。主服务可通过 `CLAUDE_URL`、`CODEX_URL`、`PIAGENT_URL` 与对应的 `_TOKEN` 调用。工作者运行隔离的 Agent 会话，接收主服务创建的任务级 MCP 地址。工具服务绑定私有入口，公共反向代理拒绝访问 `/internal/`。模型所需凭据留在运行时，百炼媒体及检索凭据留在工具服务。实际游戏运行时可由独立服务提供 `OHMYGAME_URL`。
