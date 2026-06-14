# CLAUDE.md — 个人通用助手

桌面端极轻量版 Codex，用于处理日常事务：查网页、抓数据、整理文件、执行 Python、生成 HTML/Markdown/CSV/JSON/TXT 等。

> **配套文档**：开发中遇到的问题和解决方案记录在 [`开发日志.md`](开发日志.md) 中。遇到非显而易见的 bug、架构返工或工具兼容性问题时，必须追加记录。

---

## 编码行为准则

以下原则降低常见 LLM 编码错误。**偏向谨慎优先于速度。对于简单琐碎的任务，请自行判断。**

### 1. 先思考，后编码

**不要猜测。不要隐藏困惑。把权衡摊开。**

- 明确陈述你的假设。如果不确定，就问。
- 如果存在多种解释，把它们都列出来——不要默默选一个。
- 如果有更简单的方案，说出来。必要时提出反对意见。
- 如果某件事不清楚，停下来。指出哪里困惑。提问。

### 2. 模块化设计

**高内聚、低耦合、有益复用。不做深层嵌套、不做孤立的为复用而复用。**

- **独立可拆**：功能边界清晰就拆成独立模块。
- **故障隔离**：一个模块出问题不应拖垮整个项目。
- **有益才抽象**：复用收益不明确时，宁可容忍少量重复，也不引入过早的通用化。

检验标准：修改一个需求时，能否只改动极少量模块？

### 3. 简洁优先

**用最少量的代码解决问题。不做推测性扩展。**

- 不做需求之外的功能。
- 不为一次性使用的代码做抽象。
- 不做未被要求的"灵活性"或"可配置性"。
- 不为不可能发生的场景做错误处理。
- 如果你写了 200 行但本来可以只用 50 行，重写。

### 4. 精准改动

**只动你必须动的地方。只清理你自己造成的混乱。**

- 不要"顺便改进"旁边无关的代码、注释或格式。
- 不要重构没有坏的东西。
- 匹配已有的风格，即使你本来会写得不一样。
- 发现无关的死代码，提一句——但不要删除。
- 当你的改动产生遗留未使用的代码时，删除**你改的代码**导致的 import / 变量 / 函数。

检验标准：每一行改动都应该能直接追溯到用户的请求。

### 5. 目标驱动执行

**定义成功标准。持续验证直到达标。**

- "添加校验" → "为非法输入编写测试，然后让测试通过"
- "修复这个 bug" → "编写能复现 bug 的测试，然后让测试通过"
- "重构 X" → "确保重构前后测试都能通过"

多步骤任务给出简要计划：
```
1. [步骤] → 验证：[检验点]
2. [步骤] → 验证：[检验点]
```

---

## MVP 目标

构建桌面端极轻量版 Codex：

- 查网页、读取网页内容、抓取公开数据。
- 整理数据并输出指定格式文件。
- 编写并执行 Python 代码完成特定任务。
- 生成简单 HTML 页面、Markdown 文档、CSV/JSON/TXT 等文件。
- 在受控 workspace 中读取和保存文件。

**MVP 强调"可用闭环"，不追求一开始就覆盖复杂自动化或强沙箱。**

---

## 技术选型（已冻结）

| 决策项 | 选型 | 备注 |
|--------|------|------|
| 桌面形态 | Electron + 前端聊天界面 + Node.js 主进程 + Python 长驻子进程 | 不用 FastAPI 作为 MVP 主架构 |
| LLM 接入 | OpenAI-compatible API | 配置项：`baseURL`、`apiKey`、`model` |
| Agent 编排 | OpenAI-compatible tool calling | |
| 文件访问 | 仅限当前 Topic workspace | 不允许任意读取本机路径 |
| 输出格式 | Markdown / HTML / CSV / JSON / TXT | 暂不支持 `.docx`、`.xlsx`、PDF 生成 |

---

## MVP 不做

- 长期记忆或跨 Topic 记忆检索。
- 多窗口并行执行的完整 UI（但数据结构和工具调用必须携带 `topicId`）。
- 多用户、云端部署、权限系统。
- Docker 或强沙箱隔离。
- 自动处理登录、验证码、支付、敏感操作。
- 复杂网页视觉定位。
- `.docx`、`.xlsx`、PDF 等复杂文档生成。

---

## 总体架构

```text
用户
  |
  v
Electron 前端 UI
  |
  v
Electron / Node.js 主进程
  |
  +-- Agent 编排层
  |     |
  |     +-- OpenAI-compatible LLM API
  |
  +-- 工具路由层
        |
        +-- 文件系统工具
        +-- HTTP/API 抓取工具
        +-- Playwright 浏览器工具
        +-- Python 执行工具
              |
              v
          Python 长驻子进程

Topic workspace
  |
  +-- input/
  +-- output/
  +-- temp/
  +-- downloads/
  +-- code/
```

### 核心原则

- **LLM 只做决策**，不直接操作文件、浏览器或代码运行环境。
- **工具负责实际执行**，并返回结构化结果。
- **所有工具调用必须携带 `topicId`**，并限制在该 Topic workspace 内。
- **HTTP/API 优先**：能通过 HTTP/API 完成时，不启动浏览器。
- **操作前分析，操作后验证**。

---

## Topic Workspace 设计

```text
workspace/
  topics/
    topic_<id>/
      input/          # 用户上传或手动导入的文件
      output/         # 最终生成物
      temp/           # 中间文件、缓存、临时结果
      downloads/      # HTTP/API 或浏览器下载文件
      code/           # Agent 生成并需要保存的代码文件
      topic.json      # Topic 元信息（标题、创建时间、状态等）
```

### 安全约束

- 所有路径必须 normalize 后校验，目标路径必须位于当前 Topic workspace 内。
- 禁止 `../` 越权访问。
- 删除操作 MVP 只允许删除当前 Topic 内文件。

### 并行预留（MVP 必须做）

- 文件路径解析必须基于 `topicId`。
- Python 执行器管理应预留按 Topic 分配实例的能力。
- 浏览器 page/session 应预留按 Topic 绑定的能力。
- 工具结果记录应归属于当前 Topic。
- 避免全局单例污染。

---

## 核心模块

### 1. Agent 编排层

- 接收用户消息，构建 messages 和 tools，调用 LLM API。
- 解析 tool call → 调用工具路由层 → 将结果回填给 LLM。
- 支持多轮 tool call，支持工具调用摘要展示。
- 遇到登录、验证码、支付、敏感操作时停止并询问用户。
- 工具失败时给 LLM 可读错误，由 LLM 决定重试、换工具或告知用户。

### 2. 文件系统工具

工具：`list_files` / `read_file` / `write_file` / `delete_file` / `file_exists`

### 3. HTTP/API 抓取工具（数据获取首选路径）

工具：`http_get` / `http_post` / `download_file` / `parse_html_text` / `save_response`

- 自定义 headers、query 参数、JSON body。
- 返回状态码、响应头、文本摘要。
- 自动识别并解析 JSON；HTML 转可读文本。
- 对大响应做截断或保存文件后返回摘要。
- 不绕过登录、验证码、付费墙或网站访问限制。

### 4. Playwright 浏览器工具（后备路径）

工具：`browser_navigate` / `browser_read_page` / `browser_click` / `browser_input` / `browser_scroll` / `browser_screenshot` / `browser_download_file`

- 不做自动登录、不处理验证码、不执行敏感操作、不做复杂视觉定位。

### 5. Python 执行器

通信方式：Node.js spawn Python 子进程，stdin/stdout 使用 **JSON-line 协议**。

| 方向 | 消息类型 |
|------|----------|
| Node → Python | `execute` / `install` / `cancel` / `shutdown` |
| Python → Node | `ready` / `stream_output` / `executeResult` / `error` / `shutdownAck` |

取消机制：
1. 发送 `cancel` 请求。
2. 若超时未停止，Node.js kill Python 子进程。
3. kill 后自动重启执行器（内存变量状态丢失，MVP 可接受）。

安全：Python 默认工作目录为当前 Topic workspace。MVP 不做强沙箱。

---

## 开发阶段

### Phase 1: 项目骨架和 Topic workspace
- 搭建 Electron 项目基础结构。
- 实现 Topic workspace 创建和路径解析。
- 实现基础文件系统工具。
- **验证**：能创建 Topic，读写文件，越权路径被拒绝。

### Phase 2: Python 执行器
- 实现 Python 长驻子进程和 JSON-line 协议。
- **验证**：实时输出、表达式结果返回、在 workspace 生成文件。

### Phase 3: HTTP/API 工具
- 实现 GET、POST、下载、HTML 文本提取。
- **验证**：抓取公开网页保存 Markdown，请求 JSON API 保存 JSON。

### Phase 4: LLM Agent Loop
- 接入 OpenAI-compatible API，实现 tool call 解析和多轮循环。
- **验证**：用户要求生成 HTML 时 Agent 调用工具完成；优先用 HTTP/API 工具。

### Phase 5: Playwright 浏览器工具
- 实现基础浏览器后备工具。
- **验证**：打开网页、读取文本、截图；登录/验证码场景停止并提示。

### Phase 6: 前端体验整理
- 显示回答文本、工具调用摘要、Python 输出、生成文件列表。
- **验证**：用户能清楚看到任务执行过程。

---

## MVP 验收标准

1. 用户说"生成一个简单 HTML 页面并保存" → Agent 生成文件并在文件列表显示。
2. 用户说"抓取某网页内容并整理成 Markdown" → Agent 优先用 HTTP/API 工具完成。
3. 用户说"读取这个 CSV，统计并输出 JSON" → Agent 用 Python 完成并保存结果。
4. 用户取消 Python 长任务 → 系统停止任务并恢复可用。
5. 每个 Topic 的文件互相隔离，不越权访问。
