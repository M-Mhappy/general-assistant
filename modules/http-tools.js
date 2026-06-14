/**
 * HTTP/API 抓取工具 — 数据获取首选路径。
 *
 * 工具列表：
 *   http_get      — GET 请求
 *   http_post     — POST 请求
 *   download_file — 下载文件到 Topic workspace
 *   parse_html_text — HTML 转可读文本
 *   save_response — 保存响应到文件
 *
 * 原则：
 *   - 能通过 HTTP/API 完成时，不启动浏览器。
 *   - 对大响应做截断，返回摘要。
 *   - 不绕过登录、验证码、付费墙或网站访问限制。
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const path = require('path');
const fs = require('fs');

const MAX_RESPONSE_SIZE = 2 * 1024 * 1024; // 2MB
const TRUNCATE_AT = 100 * 1024;             // 超过 100KB 截断文本
const REQUEST_TIMEOUT = 30000;              // 30 秒超时

// ============================================================
// 公共辅助
// ============================================================

/**
 * 发起 HTTP/HTTPS 请求。
 *
 * @param {string} method - GET | POST
 * @param {string} urlStr - 完整 URL
 * @param {object} opts - 可选配置
 * @param {object} [opts.headers] - 自定义请求头
 * @param {string} [opts.body] - 请求体（POST）
 * @param {string} [opts.responseType] - 'text' | 'json' | 'raw'
 * @returns {Promise<{ status: number, headers: object, body: string|object|Buffer, truncated: boolean }>}
 */
function _request(method, urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(urlStr);
    } catch (e) {
      return reject(new Error(`无效 URL: ${urlStr}`));
    }

    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const defaultHeaders = {
      'User-Agent': 'PersonalAssistant/0.1 (MVP)',
      'Accept': 'text/html,application/json,text/plain,*/*',
    };

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: { ...defaultHeaders, ...(opts.headers || {}) },
      timeout: REQUEST_TIMEOUT,
    };

    const req = transport.request(reqOptions, (res) => {
      // 处理重定向
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        // MVP: 自动跟随最多 3 次重定向
        const redirectUrl = new URL(res.headers.location, urlStr).href;
        if ((opts._redirectCount || 0) < 3) {
          return resolve(_request(method, redirectUrl, {
            ...opts,
            _redirectCount: (opts._redirectCount || 0) + 1,
          }));
        }
      }

      const chunks = [];
      let totalSize = 0;
      let truncated = false;

      res.on('data', (chunk) => {
        totalSize += chunk.length;
        if (totalSize <= MAX_RESPONSE_SIZE) {
          chunks.push(chunk);
        } else {
          truncated = true;
          res.destroy(); // 超出限制，终止接收
        }
      });

      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const responseType = opts.responseType || 'text';
        const headers = {};
        for (const [k, v] of Object.entries(res.headers)) {
          headers[k] = v;
        }

        if (responseType === 'raw') {
          return resolve({ status: res.statusCode, headers, body: raw, truncated });
        }

        const text = raw.toString('utf-8');

        if (responseType === 'json' || headers['content-type']?.includes('json')) {
          try {
            const json = JSON.parse(text);
            return resolve({ status: res.statusCode, headers, body: json, truncated });
          } catch {
            // 解析失败，返回文本
          }
        }

        resolve({ status: res.statusCode, headers, body: text, truncated });
      });

      res.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`请求超时 (${REQUEST_TIMEOUT / 1000}s): ${urlStr}`));
    });

    req.on('error', reject);

    if (opts.body) {
      req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    }

    req.end();
  });
}

// ============================================================
// 公开工具
// ============================================================

/**
 * HTTP GET 请求。
 *
 * @param {string} url
 * @param {object} [options]
 * @returns {Promise<{ status: number, headers: object, body: string|object, truncated: boolean }>}
 */
async function httpGet(url, options = {}) {
  const result = await _request('GET', url, options);

  // 大响应截断并标记
  if (typeof result.body === 'string' && result.body.length > TRUNCATE_AT) {
    result.body = result.body.slice(0, TRUNCATE_AT);
    result.truncated = true;
  }

  return result;
}

/**
 * HTTP POST 请求。
 *
 * @param {string} url
 * @param {string|object} body - 请求体
 * @param {object} [options]
 * @returns {Promise<{ status: number, headers: object, body: string|object, truncated: boolean }>}
 */
async function httpPost(url, body, options = {}) {
  const result = await _request('POST', url, { ...options, body });

  if (typeof result.body === 'string' && result.body.length > TRUNCATE_AT) {
    result.body = result.body.slice(0, TRUNCATE_AT);
    result.truncated = true;
  }

  return result;
}

/**
 * 下载文件并保存到指定路径。
 *
 * @param {string} url
 * @param {string} savePath - 保存的绝对路径
 * @returns {Promise<{ path: string, size: number, status: number }>}
 */
async function downloadFile(url, savePath) {
  // 确保父目录存在
  const parent = path.dirname(savePath);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }

  const result = await _request('GET', url, { responseType: 'raw' });

  if (result.status >= 400) {
    throw new Error(`下载失败: HTTP ${result.status} from ${url}`);
  }

  fs.writeFileSync(savePath, result.body);
  const size = result.body.length;

  return {
    path: savePath,
    size,
    status: result.status,
  };
}

/**
 * 将 HTML 转换为可读文本。
 * MVP 实现：简单去除标签和 script/style，解码常见实体。
 *
 * @param {string} html
 * @returns {string}
 */
function parseHtmlText(html) {
  // 移除 script 和 style 内容
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');

  // 常见标签替换为换行
  text = text.replace(/<\/(div|p|h[1-6]|li|tr|article|section|header|footer|main|nav|aside)>/gi, '\n');
  text = text.replace(/<(br|hr)[^>]*\/?>/gi, '\n');

  // 去除剩余 HTML 标签
  text = text.replace(/<[^>]+>/g, '');

  // 解码常见 HTML 实体
  const entities = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&ldquo;': '"',
    '&rdquo;': '"',
    '&mdash;': '—',
    '&ndash;': '–',
    '&hellip;': '…',
  };
  for (const [entity, char] of Object.entries(entities)) {
    text = text.replace(new RegExp(entity, 'g'), char);
  }
  // 数字实体
  text = text.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
  text = text.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));

  // 压缩连续空白行
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/[ \t]+/g, ' ');

  return text.trim();
}

/**
 * 保存响应内容到文件。
 *
 * @param {string|object} data - 要保存的数据
 * @param {string} savePath - 保存的绝对路径
 * @param {string} [format] - 'json' | 'text' | undefined（自动检测）
 * @returns {{ path: string, size: number }}
 */
function saveResponse(data, savePath, format) {
  const parent = path.dirname(savePath);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }

  let content;
  if (format === 'json' || (typeof data === 'object' && !format)) {
    content = JSON.stringify(data, null, 2);
  } else {
    content = String(data);
  }

  fs.writeFileSync(savePath, content, 'utf-8');
  return {
    path: savePath,
    size: Buffer.byteLength(content, 'utf-8'),
  };
}

module.exports = {
  httpGet,
  httpPost,
  downloadFile,
  parseHtmlText,
  saveResponse,
};
