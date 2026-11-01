# dsh-qwen-asr

千问语音转文字 DSH 插件。上传音频文件后自动调用千问官方 DashScope 接口转写，并把
转写文本加入本轮对话；同时提供 `qwen_transcribe_audio` 工具，返回转写文本与千问接口的
原始 JSON 输出。

**English** — Qwen speech-to-text plugin for DeepSeek Harness. Uploaded audio is
transcribed with DashScope's async filetrans model (local file → temporary upload →
task → result) or the inline sync model; the transcript joins the prompt and the
`qwen_transcribe_audio` tool returns the raw API output.

- GitHub: <https://github.com/wsdfgf/dsh-qwen-asr>
- Releases: <https://github.com/wsdfgf/dsh-qwen-asr/releases>

默认使用**异步长音频接口** `qwen3-asr-flash-filetrans`：本地文件先通过百炼临时存储
上传（得到 `oss://` 临时 URL），再提交异步任务、轮询任务状态、下载识别结果 JSON。
单文件最大 **1 GB**（百炼临时存储上传上限；模型本身支持 2 GB / 12 小时），不再需要
本地切分。

## 安装

- 从 [Releases](https://github.com/wsdfgf/dsh-qwen-asr/releases) 下载
  `dsh-qwen-asr-1.2.0.tgz`，在 DSH 侧边栏「插件」页面用「添加插件」选择本地目录或
  tarball 安装。
- 或克隆本仓库后，在插件页以本地目录安装。
- 从旧版本升级后需要重启 DSH（新增的客户端配置页才会被加载）；首次安装后刷新一次页面。

## 功能

- **上传自动转写**：聊天中上传 `.mp3/.wav/.m4a/.aac/.ogg/.flac/.amr/.webm` 等音频后，
  Host 在模型收到该消息前完成「临时上传 → 异步转写 → 下载结果」，把转写结果追加在
  附件句柄之后（不修改附件本身）。转写失败时追加失败说明，模型会如实告知。
- **原始模型输出**：工具 `qwen_transcribe_audio` 返回 `text`（识别原文）与 `raw`
  （提交响应、任务查询响应、识别结果 JSON）。长结果会做截断，避免刷爆上下文。
- **两种接口可切换**：`api=filetrans`（默认，长音频）或 `api=sync`（同步内联，
  ≤10 MB / ≤5 分钟，适合短语音）。

## 配置

插件默认从环境变量读取 API Key：`DASHSCOPE_API_KEY`（兼容 `QWEN_API_KEY`）。
也可以在聊天侧边栏的「插件」页面里直接填写：插件页 → 已安装插件 →
「千问语音转文字」→ 打开该 bundle 详情 → `qwen-asr` 行的「配置」按钮
（`dsh-qwen-asr#qwen-asr`）。表单支持 API Key、接口类型、模型、异步接口地址、
语言、自动转写开关、文件大小上限、任务超时等，保存后立即生效。刚安装或更新本插件后
需要刷新一次页面（Ctrl+R / F5），浏览器才会加载新的客户端配置页。

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `apiKey` | 空 | DashScope API Key；为空时读环境变量 |
| `apiKeyEnv` | `DASHSCOPE_API_KEY` | 读取 Key 的环境变量名 |
| `api` | `filetrans` | `filetrans` 异步长音频；`sync` 同步内联短音频 |
| `model` | `qwen3-asr-flash-filetrans` | 异步转写模型（`api=filetrans` 时使用）；也支持 `qwen-audio-3.1-asr-flash-filetrans` 等异步模型 |
| `syncModel` | `qwen3-asr-flash` | 同步模型（`api=sync` 时使用） |
| `dashscopeBaseURL` | `https://dashscope.aliyuncs.com` | 异步接口/临时上传地址（可换地域域名） |
| `baseURL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 同步接口地址 |
| `language` | `auto` | 语言提示，如 `zh`、`en`、`yue`；`auto` 表示不指定 |
| `enableItn` | `false` | 数字规范化（仅中英文） |
| `enableWords` | `false` | 异步结果返回字级时间戳（`enable_words`） |
| `autoTranscribe` | `true` | 上传音频时自动转写 |
| `injectRawOutput` | `false` | 自动注入时附带原始 JSON（截断） |
| `maxAudioBytes` | `7000000` | 同步模式内联音频上限（Base64 后 ≤10 MB） |
| `maxFileBytes` | `1000000000` | 异步模式文件上限（百炼临时上传上限 1 GB） |
| `timeoutMs` | `120000` | 单次 HTTP 请求超时 |
| `uploadTimeoutMs` | `600000` | 临时上传超时（大文件需更久） |
| `taskTimeoutMs` | `900000` | 等待异步任务完成的总超时 |
| `pollIntervalMs` | `3000` | 任务轮询间隔 |
| `audioExtensions` | 常见音频扩展名 | 自动转写识别的扩展名集合 |

## 使用

1. 在「插件」页面为本插件填写 API Key 并保存；或设置系统环境变量
   `DASHSCOPE_API_KEY` 后重启 DSH。
2. 在聊天中直接上传音频文件并提问，例如「把这段录音的要点列出来」。
   插件会先完成异步转写（大文件可能需要一两分钟），模型基于转写文本回答。
3. 需要原始模型输出时，让模型对某个音频路径调用 `qwen_transcribe_audio`，
   工具结果会包含 `Transcript` 与 `Raw Qwen API output` 两段。

## 限制

- 百炼临时存储：文件与上传时指定的模型绑定、有效期 48 小时、上传接口上限 1 GB
  （凭证接口 100 QPS，仅适合非生产场景）。生产环境建议直接把文件放 OSS，
  并使用公网 URL。
- 异步任务有排队/处理耗时；插件默认最多等待 15 分钟（`taskTimeoutMs`）。
- 自动转写结果只进入当次模型请求；后续步骤仍能看到模型基于转写文本给出的回答，
  以及会话中的原始文件句柄。需要长期保留原文时，请使用工具（工具结果会持久化）。
- 附件转写失败不会阻断对话，只会加入失败说明。
