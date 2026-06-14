/**
 * 搜索工具 — 通过 Tavily Search API 执行网页搜索。
 *
 * Tavily 是专为 AI Agent 设计的搜索 API：
 *   - 返回结构化 JSON，无需 HTML 解析
 *   - 免费额度 1000次/月，个人日常够用
 *   - 结果紧凑（~1-3KB），相比浏览器爬取节省 10-40 倍 token
 *   - 比抓取搜索引擎页面稳定可靠
 *
 * API 文档: https://docs.tavily.com
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const TAVILY_API_URL = 'https://api.tavily.com/search';
const SEARCH_TIMEOUT = 20000;

/**
 * 获取 Tavily API key。
 * 优先级：环境变量 > 硬编码（MVP 阶段）
 */
function getApiKey() {
  return process.env.TAVILY_API_KEY || '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';
}

/**
 * 调用 Tavily Search API。
 *
 * @param {string} query - 搜索关键词
 * @param {object} [options]
 * @param {number} [options.maxResults=8] - 结果数量 (max 20)
 * @param {string} [options.searchDepth='basic'] - 'basic' | 'advanced'
 * @param {boolean} [options.includeAnswer=true] - 是否包含 AI 生成的回答摘要
 * @returns {Promise<object>} 原始 API 响应
 */
function tavilySearch(query, options = {}) {
  return new Promise((resolve, reject) => {
    const apiKey = getApiKey();
    if (!apiKey) {
      return reject(new Error('未配置 Tavily API key。请在 https://tavily.com 注册获取。'));
    }

    const body = JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: options.searchDepth || 'basic',
      max_results: Math.min(options.maxResults || 8, 20),
      include_answer: options.includeAnswer !== false,
      include_raw_content: false, // 不要原始内容，节省 token
    });

    const parsedUrl = new URL(TAVILY_API_URL);
    const transport = parsedUrl.protocol === 'https:' ? https : http;

    const req = transport.request({
      hostname: parsedUrl.hostname,
      port: 443,
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: SEARCH_TIMEOUT,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode !== 200) {
          let errMsg = `Tavily API ${res.statusCode}`;
          try {
            const errJson = JSON.parse(raw);
            errMsg += `: ${errJson.message || errJson.detail || raw}`;
          } catch { errMsg += `: ${raw.slice(0, 200)}`; }
          return reject(new Error(errMsg));
        }
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error(`Tavily 响应 JSON 解析失败: ${e.message}`));
        }
      });
      res.on('error', reject);
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`Tavily 搜索超时: ${query}`)); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * 搜索并格式化为 LLM 友好的紧凑文本。
 *
 * 输出格式：
 *   [AI 摘要]（如果有）
 *   搜索 "xxx" 的结果 (N 条):
 *   [1] 标题
 *       摘要 (≤200 字符)
 *       url
 *
 * @param {string} query - 搜索关键词
 * @param {number} [maxResults=8] - 结果数量
 * @returns {Promise<string>} 格式化的搜索结果
 */
async function webSearch(query, maxResults = 8) {
  const data = await tavilySearch(query, { maxResults, includeAnswer: true });

  if (!data.results || data.results.length === 0) {
    return `未找到与 "${query}" 相关的结果。`;
  }

  const lines = [];

  // Tavily 的 AI 摘要（如果有）
  if (data.answer) {
    lines.push(`📝 ${data.answer}\n`);
  }

  lines.push(`🔍 搜索 "${query}" 的结果 (${data.results.length} 条):\n`);

  for (let i = 0; i < data.results.length; i++) {
    const r = data.results[i];
    lines.push(`[${i + 1}] ${r.title}`);
    if (r.content) {
      // 截断过长摘要，保持 token 消耗低
      const snippet = r.content.replace(/\s+/g, ' ').trim().slice(0, 200);
      lines.push(`    ${snippet}`);
    }
    lines.push(`    ${r.url}`);
    lines.push('');
  }

  // 统计：显示搜索耗时和 token 估算
  if (data.response_time) {
    const estTokens = Math.round(Buffer.byteLength(lines.join('\n'), 'utf-8') / 4);
    lines.push(`⏱ ${data.response_time.toFixed(1)}s · ~${estTokens} tokens (vs 浏览器爬取 ~20K-80K tokens)`);
  }

  return lines.join('\n').trim();
}

module.exports = {
  webSearch,
  tavilySearch, // 导出供测试
};
