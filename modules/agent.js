/**
 * Agent 编排层 — OpenAI-compatible tool calling 循环。
 *
 * 职责：
 *   - 接收用户消息，构建 messages + tools
 *   - 调用兼容 OpenAI 格式的 LLM API
 *   - 解析 tool_calls → 调用工具路由层 → 回填结果
 *   - 支持多轮 tool call，直到 LLM 产出最终回答
 *
 * 配置（环境变量）：
 *   LLM_BASE_URL — API 地址
 *   LLM_API_KEY  — API 密钥
 *   LLM_MODEL    — 模型名称
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const path = require('path');

const MAX_LLM_ITERATIONS = 30; // 防止无限 tool call 循环（搜索密集型任务需要更多轮次）
const LLM_TIMEOUT = 120000;    // 单次 API 调用超时 2 分钟

// ============================================================
// 配置
// ============================================================

function getConfig() {
  const required = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `缺少必要的环境变量: ${missing.join(', ')}。请在项目根目录创建 .env 文件（参考 .env.example）。`
    );
  }

  return {
    baseURL: process.env.LLM_BASE_URL,
    apiKey: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL,
  };
}

// ============================================================
// LLM API 调用
// ============================================================

/**
 * 调用 OpenAI-compatible chat completions API（流式）。
 *
 * 使用 SSE 协议解析流式响应，支持：
 *   - 文本增量回调 `onTextDelta`
 *   - 工具调用自动跨 chunk 拼接
 *   - 自动重定向
 *
 * @param {object[]} messages
 * @param {object[]} tools - OpenAI format tool definitions
 * @param {object} [opts]
 * @param {function} [opts.onTextDelta] - 文本增量回调 (deltaText: string) => void
 * @param {number} [opts.redirectCount] - 内部用，重定向计数
 * @returns {Promise<{ message: object, usage: object }>}
 */
function _callLLMStream(messages, tools, opts = {}) {
  const { onTextDelta, redirectCount = 0 } = opts;

  return new Promise((resolve, reject) => {
    const config = getConfig();
    if (!config.apiKey) {
      return reject(new Error('未配置 LLM_API_KEY 环境变量'));
    }

    const body = JSON.stringify({
      model: config.model,
      messages,
      tools,
      tool_choice: tools.length > 0 ? 'auto' : undefined,
      temperature: 0.3,
      stream: true,
    });

    let parsedUrl;
    try {
      parsedUrl = new URL(config.baseURL + '/chat/completions');
    } catch (e) {
      return reject(new Error(`无效 LLM_BASE_URL: ${config.baseURL}`));
    }

    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'text/event-stream',
      },
      timeout: LLM_TIMEOUT,
    }, (res) => {
      // 处理重定向
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, parsedUrl.href).href;
        if (redirectCount < 3) {
          return resolve(_callLLMStream(messages, tools, { onTextDelta, redirectCount: redirectCount + 1 }));
        }
        return reject(new Error(`LLM API 重定向次数过多: ${res.statusCode} → ${redirectUrl}`));
      }

      if (res.statusCode !== 200) {
        // 非流式错误响应，收集 body
        const errChunks = [];
        res.on('data', (c) => errChunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(errChunks).toString('utf-8');
          let errMsg = `LLM API ${res.statusCode}`;
          try {
            const errJson = JSON.parse(raw);
            errMsg += `: ${errJson.error?.message || raw}`;
          } catch { errMsg += `: ${raw.slice(0, 200)}`; }
          reject(new Error(errMsg));
        });
        res.on('error', reject);
        return;
      }

      // SSE 流式解析
      let lineBuf = '';
      const message = { role: 'assistant', content: '' };
      const toolCallAcc = {}; // keyed by index

      res.on('data', (chunk) => {
        lineBuf += chunk.toString('utf-8');
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() || ''; // 保留不完整的行

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (!delta) continue;

            // 文本增量
            if (delta.content) {
              message.content += delta.content;
              onTextDelta?.(delta.content);
            }

            // 工具调用增量（跨 chunk 拼接）
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                if (!toolCallAcc[idx]) {
                  toolCallAcc[idx] = {
                    id: tc.id || '',
                    type: 'function',
                    function: { name: '', arguments: '' },
                  };
                }
                if (tc.id) toolCallAcc[idx].id = tc.id;
                if (tc.function?.name) toolCallAcc[idx].function.name += tc.function.name;
                if (tc.function?.arguments) toolCallAcc[idx].function.arguments += tc.function.arguments;
              }
            }

            // usage 可能在最后一块
            if (parsed.usage) {
              message._usage = parsed.usage;
            }
          } catch { /* 忽略解析错误 */ }
        }
      });

      res.on('end', () => {
        // 组装 tool_calls
        const toolCallsArr = Object.values(toolCallAcc).filter((tc) => tc.id);
        if (toolCallsArr.length > 0) {
          message.tool_calls = toolCallsArr;
        }

        resolve({
          message,
          usage: message._usage || null,
        });
      });

      res.on('error', reject);
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('LLM API 超时')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * 调用 LLM API（兼容旧接口）。
 * 用于压缩摘要等场景，也支持 onTextDelta 流式回调。
 */
function callLLM(messages, tools, opts = {}) {
  return _callLLMStream(messages, tools, opts);
}

// ============================================================
// 工具定义（OpenAI function calling 格式）
// ============================================================

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '获取当前日期和时间。在需要知道"今天""本月""今年"或计算时间差时使用。',
      parameters: {
        type: 'object',
        properties: {
          format: { type: 'string', description: '可选，返回值格式："full"（完整日期时间）| "date"（仅日期）| "iso"。默认 "full"' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出指定目录下的文件和子目录',
      parameters: {
        type: 'object',
        properties: {
          subPath: { type: 'string', description: '要列出的子目录路径，默认为当前目录' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取 Topic workspace 内的文件内容',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '相对路径，如 "output/result.txt"' },
        },
        required: ['filePath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '将内容写入 Topic workspace 内的文件',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '相对路径，如 "output/page.html"' },
          content: { type: 'string', description: '要写入的完整内容' },
        },
        required: ['filePath', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '通过搜索引擎搜索网页。用于获取最新信息、实时数据、或回答需要事实核查的问题。返回标题、摘要和 URL。相比浏览器爬取节省 10-40 倍 token，优先使用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，用简洁的词语描述要查找的信息' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'http_get',
      description: '发起 HTTP GET 请求获取网页或 API 数据。用于获取搜索结果的完整网页内容。优先使用 web_search 搜索，再用此工具获取具体页面详情。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整的 URL 地址' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'http_post',
      description: '发起 HTTP POST 请求',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整的 URL 地址' },
          body: { type: 'string', description: '请求体（JSON 字符串或文本）' },
        },
        required: ['url', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'download_file',
      description: '下载文件到 Topic workspace 的 downloads/ 目录',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '下载链接' },
          fileName: { type: 'string', description: '保存的文件名，不指定则从 URL 自动提取' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'parse_html',
      description: '将 HTML 文本转换为可读纯文本',
      parameters: {
        type: 'object',
        properties: {
          html: { type: 'string', description: '原始 HTML 字符串' },
        },
        required: ['html'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'parse_file',
      description: '解析文档文件内容，支持 .docx/.pdf/.xlsx/.txt/.csv/.md/.json 等格式。用于读取用户上传的 Word/PDF/Excel 文档或工作区内任意文本文件。自动检测文件编码。',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '文件在 workspace 中的相对路径，如 "input/report.docx"' },
        },
        required: ['filePath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_python',
      description: '执行 Python 代码进行数据分析、文件处理、图表生成等。代码将在 Topic workspace 内执行。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '要执行的 Python 代码' },
        },
        required: ['code'],
      },
    },
  },
];

// ============================================================
// 工具执行器（路由层）
// ============================================================

/**
 * 执行单个工具调用并返回结果字符串。
 *
 * @param {string} toolName
 * @param {string} toolArgs - JSON 字符串参数
 * @param {object} context - { topicId, topicPath, fileTools, httpTools, pythonExecutor }
 * @returns {Promise<string>}
 */
async function executeToolCall(toolName, toolArgs, context) {
  const args = JSON.parse(toolArgs);
  const { topicPath, fileTools, httpTools } = context;

  switch (toolName) {
    case 'get_current_time': {
      const now = new Date();
      const fmt = (args.format || 'full').toLowerCase();
      if (fmt === 'iso') return now.toISOString();
      if (fmt === 'date') return now.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' });
      // full: 完整日期 + 时间 + 星期
      return now.toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        weekday: 'long',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZoneName: 'short',
      });
    }

    case 'web_search': {
      if (!context.searchTools) return '搜索工具未配置';
      const results = await context.searchTools.webSearch(args.query, 8);
      return results;
    }

    case 'list_files': {
      const files = fileTools.listFiles(topicPath, args.subPath || '');
      return JSON.stringify(files);
    }

    case 'read_file': {
      const content = fileTools.readFile(topicPath, args.filePath);
      return content;
    }

    case 'write_file': {
      fileTools.writeFile(topicPath, args.filePath, args.content);
      return `文件已写入: ${args.filePath}`;
    }

    case 'http_get': {
      const result = await httpTools.httpGet(args.url);
      return JSON.stringify({
        status: result.status,
        body: result.body,
        truncated: result.truncated || false,
      });
    }

    case 'http_post': {
      const result = await httpTools.httpPost(args.url, args.body);
      return JSON.stringify({
        status: result.status,
        body: result.body,
      });
    }

    case 'download_file': {
      const savePath = require('path').join(topicPath, 'downloads', args.fileName || 'download');
      const result = await httpTools.downloadFile(args.url, savePath);
      return `下载完成: ${result.path} (${result.size} 字节)`;
    }

    case 'parse_html': {
      const text = httpTools.parseHtmlText(args.html);
      return text;
    }

    case 'parse_file': {
      const fullPath = require('path').join(topicPath, args.filePath);
      if (!context.pythonExecutor) return 'Python 执行器未就绪，无法解析文档';
      try {
        const parseResult = await context.pythonExecutor.parseDocument(fullPath);
        return parseResult.result || '(解析结果为空)';
      } catch (e) {
        return `文档解析失败: ${e.message}`;
      }
    }

    case 'execute_python': {
      if (!context.pythonExecutor) return 'Python 执行器未就绪';
      try {
        const execResult = await context.pythonExecutor.execute(args.code, topicPath);
        return JSON.stringify({
          result: execResult.result,
          stdout: execResult.stdout,
          stderr: execResult.stderr,
          files: execResult.files,
        });
      } catch (e) {
        return `Python 执行错误: ${e.message}`;
      }
    }

    default:
      return `未知工具: ${toolName}`;
  }
}

// ============================================================
// 任务执行可观察性
// ============================================================

function getLatestUserGoal(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return String(messages[i].content || '').trim();
  }
  return '处理用户请求';
}

function createTaskId() {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function shouldUsePlannedMode(goal) {
  const text = goal || '';
  if (text.length >= 80) return true;
  return /(整理|分析|统计|调研|研究|比较|总结|抓取|爬取|生成.*报告|读取.*文件|读取.*表格|批量|多个|保存|输出|转换|清洗|可视化|网页|CSV|Excel|PDF|Word|Markdown|HTML|JSON)/i.test(text);
}

function buildTaskPlan(goal, mode) {
  if (mode === 'direct') {
    return [
      { id: 'step_direct', title: '直接处理请求', status: 'pending', kind: 'work' },
      { id: 'step_verify', title: '检查结果', status: 'pending', kind: 'verify' },
    ];
  }

  return [
    { id: 'step_understand', title: '理解目标并选择路径', status: 'pending', kind: 'understand' },
    { id: 'step_gather', title: '获取或读取必要信息', status: 'pending', kind: 'gather' },
    { id: 'step_process', title: '处理信息并生成结果', status: 'pending', kind: 'process' },
    { id: 'step_verify', title: '验证产物与回答', status: 'pending', kind: 'verify' },
  ];
}

function publicPlan(plan) {
  return plan.map(({ id, title, status }) => ({ id, title, status }));
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function summarizeToolArgs(toolName, args) {
  if (!args || typeof args !== 'object') return '';
  if (args.query) return args.query;
  if (args.url) return args.url;
  if (args.filePath) return args.filePath;
  if (args.subPath) return args.subPath;
  if (args.code) return args.code.split('\n')[0].slice(0, 80);
  if (args.format) return args.format;
  return toolName;
}

function summarizeToolResult(toolName, result, error) {
  if (error) return `${toolName} 执行失败: ${error}`;

  const text = typeof result === 'string' ? result : JSON.stringify(result);
  if (!text) return `${toolName} 已完成`;

  if (toolName === 'read_file' || toolName === 'parse_file') {
    return `${toolName} 已读取 ${text.length} 字符`;
  }

  if (toolName === 'execute_python') {
    const parsed = safeJsonParse(text);
    if (parsed) {
      const parts = [];
      if (parsed.stdout) parts.push(`stdout ${String(parsed.stdout).length} 字符`);
      if (parsed.stderr) parts.push(`stderr ${String(parsed.stderr).length} 字符`);
      if (Array.isArray(parsed.files) && parsed.files.length > 0) parts.push(`生成 ${parsed.files.length} 个文件`);
      if (parsed.result) parts.push('返回结果');
      return parts.length ? `Python 执行完成，${parts.join('，')}` : 'Python 执行完成';
    }
  }

  if (toolName === 'write_file') return text;
  if (toolName === 'download_file') return text;
  if (toolName === 'web_search') return `搜索完成，返回约 ${text.length} 字符结果`;
  if (toolName === 'http_get' || toolName === 'http_post') return `${toolName} 完成，返回约 ${text.length} 字符`;

  return text.length > 160 ? `${text.slice(0, 160)}...` : text;
}

function normalizeArtifactPath(topicPath, artifactPath) {
  if (!artifactPath) return null;
  const raw = String(artifactPath);
  const root = path.resolve(topicPath);

  if (path.isAbsolute(raw)) {
    const resolved = path.resolve(raw);
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      return path.relative(root, resolved).replace(/\\/g, '/');
    }
    return raw;
  }

  return path.normalize(raw).replace(/\\/g, '/');
}

function extractArtifacts(toolName, args, result, context) {
  const artifacts = [];
  const add = (filePath, source) => {
    const normalized = normalizeArtifactPath(context.topicPath, filePath);
    if (!normalized) return;
    artifacts.push({ path: normalized, source });
  };

  if (toolName === 'write_file' && args?.filePath) {
    add(args.filePath, toolName);
  }

  if (toolName === 'download_file') {
    if (args?.fileName) add(`downloads/${args.fileName}`, toolName);
    const match = String(result || '').match(/下载完成:\s*(.+?)\s*\(/);
    if (match) add(match[1], toolName);
  }

  if (toolName === 'browser_screenshot' && args?.fileName) {
    add(args.fileName, toolName);
  }

  if (toolName === 'execute_python') {
    const parsed = safeJsonParse(result);
    if (parsed && Array.isArray(parsed.files)) {
      for (const f of parsed.files) add(f, toolName);
    }
  }

  return artifacts;
}

function stepForTool(plan, toolName) {
  const byKind = (kind) => plan.find((s) => s.kind === kind) || plan[0];

  if (plan.length === 2) return plan[0];

  if ([
    'web_search', 'http_get', 'http_post', 'download_file', 'parse_html',
    'parse_file', 'read_file', 'list_files',
  ].includes(toolName)) {
    return byKind('gather');
  }

  if ([
    'execute_python', 'write_file',
  ].includes(toolName)) {
    return byKind('process');
  }

  return byKind('process');
}

function verifyArtifacts(context, artifacts) {
  if (!artifacts.length) {
    return [{ label: '最终回答', ok: true, detail: '已生成可读回答' }];
  }

  return artifacts.map((artifact) => {
    const filePath = artifact.path;
    let ok = true;
    let detail = '已记录产物';

    try {
      if (context.fileTools && filePath && !path.isAbsolute(filePath)) {
        ok = context.fileTools.fileExists(context.topicPath, filePath);
        detail = ok ? '文件存在' : '文件不存在';
      }
    } catch (err) {
      ok = false;
      detail = err.message;
    }

    return { label: filePath, ok, detail };
  });
}

function createTaskObserver(context, conversationHistory, onProgress) {
  const goal = getLatestUserGoal(conversationHistory);
  const mode = shouldUsePlannedMode(goal) ? 'planned' : 'direct';
  const taskId = createTaskId();
  const plan = buildTaskPlan(goal, mode);
  const state = {
    taskId,
    goal,
    mode,
    plan,
    currentStepId: null,
    completedSteps: new Set(),
    artifacts: [],
  };

  const emit = (event) => onProgress?.({ taskId, ...event });

  const stepById = (stepId) => plan.find((s) => s.id === stepId);

  const startStep = (stepId, detail) => {
    if (!stepId || state.currentStepId === stepId) return;

    if (state.currentStepId && !state.completedSteps.has(state.currentStepId)) {
      completeStep(state.currentStepId);
    }

    state.currentStepId = stepId;
    const step = stepById(stepId);
    if (!step) return;
    step.status = 'running';
    emit({ type: 'step_started', step: { id: step.id, title: step.title, status: step.status }, detail });
  };

  const completeStep = (stepId, detail) => {
    const step = stepById(stepId);
    if (!step || state.completedSteps.has(stepId)) return;
    step.status = 'done';
    state.completedSteps.add(stepId);
    emit({ type: 'step_completed', step: { id: step.id, title: step.title, status: step.status }, detail });
  };

  const failStep = (stepId, detail) => {
    const step = stepById(stepId);
    if (!step) return;
    step.status = 'failed';
    state.completedSteps.add(stepId);
    emit({ type: 'step_failed', step: { id: step.id, title: step.title, status: step.status }, detail });
  };

  const addObservation = (summary) => {
    if (!summary) return;
    emit({ type: 'observation_added', summary });
  };

  const addArtifacts = (artifacts) => {
    for (const artifact of artifacts) {
      if (!artifact?.path) continue;
      const exists = state.artifacts.some((a) => a.path === artifact.path);
      if (exists) continue;
      state.artifacts.push(artifact);
      emit({ type: 'artifact_created', artifact });
    }
  };

  emit({
    type: 'task_created',
    task: {
      id: taskId,
      goal,
      mode,
      status: 'running',
      startedAt: new Date().toISOString(),
    },
  });
  emit({ type: 'plan_created', mode, plan: publicPlan(plan) });
  startStep(plan[0].id, mode === 'planned' ? '建立执行路径' : '准备直接处理');

  return {
    taskId,
    beforeTool(toolName, rawArgs) {
      const args = safeJsonParse(rawArgs) || {};
      if (state.currentStepId === plan[0].id) {
        completeStep(plan[0].id, '已选择工具执行路径');
      }
      const step = stepForTool(plan, toolName);
      startStep(step.id, summarizeToolArgs(toolName, args));
    },
    afterTool(toolName, rawArgs, result, error) {
      const args = safeJsonParse(rawArgs) || {};
      if (error && state.currentStepId) {
        failStep(state.currentStepId, error);
      }
      addObservation(summarizeToolResult(toolName, result, error));
      addArtifacts(extractArtifacts(toolName, args, result, context));
    },
    finish() {
      if (state.currentStepId && state.currentStepId !== 'step_verify') {
        completeStep(state.currentStepId);
      }

      const verifyStep = plan.find((s) => s.kind === 'verify') || plan[plan.length - 1];
      startStep(verifyStep.id, '检查关键产物和最终回答');
      emit({ type: 'verification_started', artifacts: state.artifacts });
      const checks = verifyArtifacts(context, state.artifacts);
      emit({ type: 'verification_finished', checks });
      completeStep(verifyStep.id, checks.every((c) => c.ok) ? '验证通过' : '部分检查未通过');

      emit({
        type: 'task_completed',
        task: {
          id: taskId,
          goal,
          mode,
          status: 'completed',
          artifacts: state.artifacts,
          completedAt: new Date().toISOString(),
        },
      });

      return {
        id: taskId,
        goal,
        mode,
        artifacts: state.artifacts,
        checks,
      };
    },
    fail(message) {
      if (state.currentStepId) failStep(state.currentStepId, message);
      emit({
        type: 'task_completed',
        task: {
          id: taskId,
          goal,
          mode,
          status: 'failed',
          artifacts: state.artifacts,
          completedAt: new Date().toISOString(),
        },
      });
    },
  };
}

// ============================================================
// Agent 主循环
// ============================================================

/**
 * 运行 Agent 对话循环（流式输出版本）。
 *
 * @param {object} context - { topicId, topicPath, fileTools, httpTools, searchTools, pythonExecutor }
 * @param {object[]} conversationHistory - 已有的 messages 数组
 * @param {object} [callbacks] - 事件回调
 * @param {function} [callbacks.onToolCall] - (name, args) => void（兼容旧接口）
 * @param {function} [callbacks.onResponse] - (text) => void（兼容旧接口）
 * @param {function} [callbacks.onProgress] - (event) => void（流式进度事件）
 *   事件类型：
 *     { type: 'task_created', task }         — 创建可观察任务
 *     { type: 'plan_created', plan }         — 生成轻量执行计划
 *     { type: 'step_started', step }         — 步骤开始
 *     { type: 'observation_added', summary } — 工具观察摘要
 *     { type: 'artifact_created', artifact } — 产物记录
 *     { type: 'verification_finished', checks } — 验证完成
 *     { type: 'task_completed', task }       — 任务完成
 *     { type: 'llm_request', iteration }     — 发起 LLM 调用
 *     { type: 'text_delta', text }           — 流式文本增量
 *     { type: 'tool_start', name, args }     — 工具开始执行
 *     { type: 'tool_end', name, args, result, error? } — 工具执行完成
 *     { type: 'done' }                       — 本轮对话完成
 *     { type: 'error', message }             — 错误
 * @returns {Promise<{ messages: object[], usage: object[] }>}
 */
async function runAgentLoop(context, conversationHistory, callbacks = {}) {
  const { onToolCall, onResponse, onProgress } = callbacks;
  const tools = TOOL_DEFINITIONS;
  const usages = [];
  const taskObserver = createTaskObserver(context, conversationHistory, onProgress);
  let iterations = 0;
  let taskResult = null;

  while (iterations < MAX_LLM_ITERATIONS) {
    iterations++;

    onProgress?.({ type: 'llm_request', iteration: iterations });

    const { message, usage } = await _callLLMStream(conversationHistory, tools, {
      onTextDelta: (text) => onProgress?.({ type: 'text_delta', text }),
    });

    if (usage) usages.push(usage);
    conversationHistory.push(message);

    // 无 tool_calls -> 最终回答
    if (!message.tool_calls || message.tool_calls.length === 0) {
      const content = message.content || '';
      onResponse?.(content);
      taskResult = taskObserver.finish();
      onProgress?.({ type: 'done' });
      return { messages: conversationHistory, usage: usages, task: taskResult };
    }

    // 执行 tool calls（逐个执行，实时推送结果）
    for (const tc of message.tool_calls) {
      const toolName = tc.function.name;
      const toolArgs = tc.function.arguments;

      onToolCall?.(toolName, toolArgs);
      taskObserver.beforeTool(toolName, toolArgs);
      onProgress?.({ type: 'tool_start', name: toolName, args: toolArgs });

      let toolResult;
      let toolError = null;
      try {
        toolResult = await executeToolCall(toolName, toolArgs, context);
      } catch (err) {
        toolResult = `工具执行错误: ${err.message}`;
        toolError = err.message;
      }
      taskObserver.afterTool(toolName, toolArgs, toolResult, toolError);

      onProgress?.({
        type: 'tool_end',
        name: toolName,
        args: toolArgs,
        result: toolResult,
        error: toolError,
      });

      // 逐个推送 tool 结果到对话历史
      conversationHistory.push({
        tool_call_id: tc.id,
        role: 'tool',
        content: toolResult,
      });
    }
  }

  // 超过最大迭代次数，返回最后一个 message
  const lastMsg = conversationHistory[conversationHistory.length - 1];
  const content = (lastMsg.role === 'assistant' && lastMsg.content) || '执行超过最大步数，请简化请求。';
  onResponse?.(content);
  taskObserver.fail('执行超过最大步数');
  onProgress?.({ type: 'done' });
  return { messages: conversationHistory, usage: usages, task: taskResult };
}

// ============================================================
// 对话历史压缩（上下文窗口管理）
// ============================================================

const COMPRESS_THRESHOLD = 50000; // token 阈值
const KEEP_RECENT = 20;           // 保留最近 20 条消息不压缩

/**
 * 粗略估算 messages 数组的 token 数。
 * 中文约 1.5-2 字符/token，英文约 4 字符/token。取 2 字符/token 作为上界估算。
 */
function estimateTokens(messages) {
  let total = 0;
  for (const m of messages) {
    let content = '';
    if (typeof m.content === 'string') {
      content = m.content;
    } else if (m.content) {
      content = JSON.stringify(m.content);
    }
    // 角色和结构开销约 4 token
    total += 4 + Math.ceil(content.length / 2);

    // tool_calls 的开销
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        total += 8
          + Math.ceil((tc.function?.name || '').length / 2)
          + Math.ceil((tc.function?.arguments || '').length / 2);
      }
    }
  }
  return total;
}

/**
 * 压缩对话历史。当 token 数超过阈值时，用 LLM 将早期消息摘要化。
 *
 * 保留策略：
 *   - 第一条 system message 原样保留
 *   - 最近 KEEP_RECENT 条消息保持完整上下文
 *   - 中间部分用 LLM 生成一段中文摘要替代
 *
 * @param {object[]} messages - 完整的消息数组（会被读取但不会被原地修改）
 * @param {number} [threshold=80000] - 触发压缩的 token 阈值
 * @returns {Promise<object[]>} 压缩后的新数组（若无需压缩则返回原数组）
 */
async function compressHistory(messages, threshold = COMPRESS_THRESHOLD) {
  const tokens = estimateTokens(messages);
  if (tokens <= threshold) return messages;

  const systemMsg = messages[0];
  const totalLen = messages.length;

  // 消息太少，无需压缩
  if (totalLen <= KEEP_RECENT + 2) return messages;

  const recent = messages.slice(-KEEP_RECENT);
  const toSummarize = messages.slice(1, -KEEP_RECENT);

  if (toSummarize.length === 0) return messages;

  // 构建精简版历史供摘要：每条内容截断到 200 字符，tool 消息截断到 100 字符
  const slimHistory = toSummarize.map((m) => {
    const entry = { role: m.role };
    if (m.content) {
      const maxLen = m.role === 'tool' ? 100 : 200;
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      entry.content = text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
    }
    if (m.tool_calls) {
      entry.tools = m.tool_calls.map((tc) => tc.function?.name || '?');
    }
    return entry;
  });

  try {
    const summaryResult = await callLLM(
      [
        {
          role: 'system',
          content:
            '你是一个对话摘要器。请用 3-5 句中文总结以下对话中用户完成了什么任务、使用了哪些工具、产生了哪些文件和关键数据。只保留事实，不评价、不延伸。',
        },
        {
          role: 'user',
          content: JSON.stringify(slimHistory, null, 2),
        },
      ],
      [] // 空 tools，纯文本回答
    );

    const summary = summaryResult.message?.content || '(摘要生成失败)';

    console.log(
      `[agent] 历史压缩完成: ${toSummarize.length} 条 → 1 条摘要 (~${estimateTokens(toSummarize)} → ~${Math.ceil(summary.length / 2)} tokens)`
    );

    return [
      systemMsg,
      {
        role: 'system',
        content: `[对话历史摘要 — 之前对话的关键事实]\n${summary}\n[摘要结束，以下是最近的对话]`,
      },
      ...recent,
    ];
  } catch (err) {
    console.error('[agent] 摘要生成失败，使用简单截断:', err.message);
    return [
      systemMsg,
      { role: 'system', content: '[早期对话已省略，上下文过长]' },
      ...recent,
    ];
  }
}

module.exports = {
  runAgentLoop,
  compressHistory,
  estimateTokens,
  TOOL_DEFINITIONS,
  getConfig,
  callLLM, // 导出供测试使用
};
