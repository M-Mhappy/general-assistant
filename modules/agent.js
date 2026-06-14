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

const MAX_LLM_ITERATIONS = 30; // 防止无限 tool call 循环（搜索密集型任务需要更多轮次）
const LLM_TIMEOUT = 120000;    // 单次 API 调用超时 2 分钟

// ============================================================
// 配置
// ============================================================

function getConfig() {
  return {
    baseURL: process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1',
    apiKey: process.env.LLM_API_KEY || 'sk-f677900846a247d786fc78f1932211de',
    model: process.env.LLM_MODEL || 'deepseek-v4-pro',
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
  let iterations = 0;

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
      onProgress?.({ type: 'done' });
      return { messages: conversationHistory, usage: usages };
    }

    // 执行 tool calls（逐个执行，实时推送结果）
    for (const tc of message.tool_calls) {
      const toolName = tc.function.name;
      const toolArgs = tc.function.arguments;

      onToolCall?.(toolName, toolArgs);
      onProgress?.({ type: 'tool_start', name: toolName, args: toolArgs });

      let toolResult;
      let toolError = null;
      try {
        toolResult = await executeToolCall(toolName, toolArgs, context);
      } catch (err) {
        toolResult = `工具执行错误: ${err.message}`;
        toolError = err.message;
      }

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
  onProgress?.({ type: 'done' });
  return { messages: conversationHistory, usage: usages };
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
 * @param {number} [threshold=50000] - 触发压缩的 token 阈值
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
