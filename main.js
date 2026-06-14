/**
 * Electron 主进程入口。
 *
 * 架构层次：
 *   main.js (本文件)   — Electron 生命周期、窗口管理、IPC 路由
 *   preload.js         — 安全桥接，暴露受限 API 给渲染进程
 *   modules/*          — 业务逻辑模块
 */

// 必须在所有其他 require 之前加载 .env
require('dotenv').config();

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const topicManager = require('./modules/topic-manager');
const fileTools = require('./modules/file-tools');
const httpTools = require('./modules/http-tools');
const browserTools = require('./modules/browser-tools');
const searchTools = require('./modules/search-tools');
const PythonExecutor = require('./modules/python-executor');
const agent = require('./modules/agent');

// 全局 Python 执行器实例（MVP：单实例共享，后续按 Topic 分配）
const pythonExecutor = new PythonExecutor();

/** @type {BrowserWindow | null} */
let mainWindow = null;

// ============================================================
// 窗口创建
// ============================================================

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 600,
    minHeight: 400,
    title: '个人通用助手',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 开发模式下打开 DevTools
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// ============================================================
// IPC 路由 — Topic 管理
// ============================================================

ipcMain.handle('topic:getOrCreate', () => {
  const meta = topicManager.getOrCreateDefaultTopic();
  return { success: true, data: meta };
});

ipcMain.handle('topic:create', (_event, title) => {
  const meta = topicManager.createTopic(title);
  return { success: true, data: meta };
});

ipcMain.handle('topic:list', () => {
  const topics = topicManager.listAllTopics().map((t) => ({
    ...t,
    meta: topicManager.readTopicMeta(t.id),
  }));
  return { success: true, data: topics };
});

ipcMain.handle('topic:getMeta', (_event, topicId) => {
  const meta = topicManager.readTopicMeta(topicId);
  if (!meta) return { success: false, error: `Topic "${topicId}" 不存在` };
  return { success: true, data: meta };
});

// ============================================================
// IPC 路由 — 文件工具
// ============================================================

/**
 * 从请求中提取 topicPath。
 * 调用方需传入 topicId，服务端据此解析 workspace 根路径。
 */
function getTopicPath(topicId) {
  return topicManager.getTopicPath(topicId);
}

ipcMain.handle('file:list', (_event, { topicId, subPath }) => {
  try {
    const topicPath = getTopicPath(topicId);
    const files = fileTools.listFiles(topicPath, subPath || '');
    return { success: true, data: files };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('file:read', (_event, { topicId, filePath }) => {
  try {
    const topicPath = getTopicPath(topicId);
    const content = fileTools.readFile(topicPath, filePath);
    return { success: true, data: content };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('file:write', (_event, { topicId, filePath, content }) => {
  try {
    const topicPath = getTopicPath(topicId);
    fileTools.writeFile(topicPath, filePath, content);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('file:delete', (_event, { topicId, filePath }) => {
  try {
    const topicPath = getTopicPath(topicId);
    fileTools.deleteFile(topicPath, filePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('file:exists', (_event, { topicId, filePath }) => {
  try {
    const topicPath = getTopicPath(topicId);
    const exists = fileTools.fileExists(topicPath, filePath);
    return { success: true, data: exists };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ============================================================
// IPC 路由 — HTTP/API 工具
// ============================================================

ipcMain.handle('http:get', async (_event, { url, options }) => {
  try {
    const result = await httpTools.httpGet(url, options);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('http:post', async (_event, { url, body, options }) => {
  try {
    const result = await httpTools.httpPost(url, body, options);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('http:download', async (_event, { topicId, url, fileName }) => {
  try {
    const topicPath = getTopicPath(topicId);
    const savePath = path.join(topicPath, 'downloads', fileName || path.basename(url) || 'download');
    const result = await httpTools.downloadFile(url, savePath);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('http:parseHtml', (_event, { html }) => {
  try {
    const text = httpTools.parseHtmlText(html);
    return { success: true, data: text };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('http:saveResponse', (_event, { topicId, data, filePath, format }) => {
  try {
    const topicPath = getTopicPath(topicId);
    const savePath = path.join(topicPath, filePath);
    const result = httpTools.saveResponse(data, savePath, format);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('file:getPath', (_event, { topicId, filePath }) => {
  try {
    const topicPath = getTopicPath(topicId);
    const fullPath = require('path').join(topicPath, filePath);
    return { success: true, data: fullPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('file:open', async (_event, { topicId, filePath }) => {
  try {
    const topicPath = getTopicPath(topicId);
    const fullPath = require('path').join(topicPath, filePath);
    const result = await shell.openPath(fullPath);
    if (result) throw new Error(result); // shell.openPath 返回错误字符串或空字符串
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * 文件上传：打开系统文件选择对话框，将选中文件复制到 Topic 的 input/ 目录。
 */
ipcMain.handle('file:upload', async (_event, { topicId }) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择要上传的文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '所有支持的文件',
          extensions: [
            'txt', 'md', 'csv', 'json', 'docx', 'pdf', 'xlsx', 'xls', 'xlsm',
            'pptx', 'html', 'htm', 'xml', 'yaml', 'yml',
            'py', 'js', 'ts', 'css', 'sh', 'bat', 'ps1',
            'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp',
          ],
        },
        { name: '所有文件', extensions: ['*'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: true, data: [] };
    }

    const topicPath = getTopicPath(topicId);
    const inputDir = pathLib.join(topicPath, 'input');
    if (!fsLib.existsSync(inputDir)) fsLib.mkdirSync(inputDir, { recursive: true });

    const copied = [];
    for (const srcPath of result.filePaths) {
      const fileName = pathLib.basename(srcPath);
      let destPath = pathLib.join(inputDir, fileName);
      // 如果同名文件已存在，加序号
      if (fsLib.existsSync(destPath)) {
        const ext = pathLib.extname(fileName);
        const base = pathLib.basename(fileName, ext);
        let counter = 1;
        while (fsLib.existsSync(destPath)) {
          destPath = pathLib.join(inputDir, `${base}_(${counter})${ext}`);
          counter++;
        }
      }
      fsLib.copyFileSync(srcPath, destPath);
      copied.push(pathLib.relative(inputDir, destPath));
    }

    return { success: true, data: copied };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * 文档解析：使用 Python 解析 .docx / .pdf / .xlsx 等复杂格式文件。
 */
ipcMain.handle('file:parse', async (_event, { topicId, filePath }) => {
  try {
    const topicPath = getTopicPath(topicId);
    const fullPath = pathLib.join(topicPath, filePath);

    // 确保 Python 执行器已启动
    if (!pythonExecutor.ready && !pythonExecutor.process) {
      pythonExecutor.start();
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Python 启动超时')), 15000);
        pythonExecutor.once('ready', () => { clearTimeout(t); resolve(); });
        pythonExecutor.once('error', (err) => { clearTimeout(t); reject(err); });
      });
    }

    const result = await pythonExecutor.parseDocument(fullPath);
    return { success: true, data: result.result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ============================================================
// IPC 路由 — Playwright 浏览器工具
// ============================================================

ipcMain.handle('browser:navigate', async (_event, { topicId, url }) => {
  try {
    const result = await browserTools.browserNavigate(topicId, url);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('browser:readPage', async (_event, { topicId }) => {
  try {
    const text = await browserTools.browserReadPage(topicId);
    return { success: true, data: text };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('browser:click', async (_event, { topicId, selector }) => {
  try {
    const result = await browserTools.browserClick(topicId, selector);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('browser:input', async (_event, { topicId, selector, text }) => {
  try {
    const result = await browserTools.browserInput(topicId, selector, text);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('browser:scroll', async (_event, { topicId, direction, px }) => {
  try {
    const result = await browserTools.browserScroll(topicId, direction, px);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('browser:screenshot', async (_event, { topicId, fileName }) => {
  try {
    const topicPath = getTopicPath(topicId);
    const result = await browserTools.browserScreenshot(topicId, topicPath, fileName);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('browser:downloadFile', async (_event, { topicId, url, selector }) => {
  try {
    const topicPath = getTopicPath(topicId);
    const result = await browserTools.browserDownloadFile(topicId, topicPath, url, selector);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ============================================================
// IPC 路由 — Web Search
// ============================================================

ipcMain.handle('search:web', async (_event, { query, maxResults }) => {
  try {
    const result = await searchTools.webSearch(query, maxResults);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ============================================================
// IPC 路由 — Agent
// ============================================================

// ============================================================
// 对话历史持久化
// ============================================================

const pathLib = require('path');
const fsLib = require('fs');

/**
 * 获取 Topic 的对话历史文件路径。
 */
function getConversationPath(topicId) {
  return pathLib.join(getTopicPath(topicId), 'conversation.json');
}

/**
 * 从磁盘加载对话历史。不存在则返回 null。
 */
function loadConversation(topicId) {
  const filePath = getConversationPath(topicId);
  if (!fsLib.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fsLib.readFileSync(filePath, 'utf-8'));
    if (Array.isArray(data) && data.length > 0) return data;
    return null;
  } catch {
    return null;
  }
}

/**
 * 将对话历史保存到磁盘。
 */
function saveConversation(topicId, history) {
  const filePath = getConversationPath(topicId);
  fsLib.writeFileSync(filePath, JSON.stringify(history, null, 2), 'utf-8');
}

/**
 * 构建新对话的初始 system message。
 */
function buildSystemMessage() {
  const now = new Date();
  return {
    role: 'system',
    content: `你是一个桌面助手，运行在用户的个人电脑上。你可以：
- 读写用户 workspace 内的文件
- 搜索网页获取最新信息（优先使用 web_search）
- 发起 HTTP 请求获取网页内容和 API 数据
- 执行 Python 代码进行数据处理、文件生成等

当前时间：${now.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}。如果涉及时间相关任务，以这个时间为准。

重要规则：
- 所有文件操作限制在当前 workspace 内
- 搜索信息时，必须使用当前时间构建搜索关键词，确保信息时效性
- 优先使用 web_search 获取信息，HTTP/API 获取具体页面详情
- 遇到登录、验证码、支付、删除账号等敏感操作时，必须停止并告知用户
- 生成 HTML 页面、Markdown 文档时，使用 write_file 工具保存到 output/ 目录
- 生成的 Python 代码应保存在 code/ 目录`,
  };
}

// 内存缓存：避免每次请求都读写磁盘
const conversationCache = new Map();

/**
 * 获取或初始化 Topic 的对话历史。
 * 优先从磁盘加载，其次创建新的。
 */
function getOrCreateConversation(topicId) {
  if (conversationCache.has(topicId)) return conversationCache.get(topicId);

  const loaded = loadConversation(topicId);
  if (loaded) {
    // 更新 system message 中的时间为当前时间
    if (loaded[0]?.role === 'system') {
      loaded[0] = buildSystemMessage();
    }
    conversationCache.set(topicId, loaded);
    return loaded;
  }

  const fresh = [buildSystemMessage()];
  conversationCache.set(topicId, fresh);
  saveConversation(topicId, fresh);
  return fresh;
}

/**
 * Agent 对话接口。
 * 接收用户消息，通过 Agent 编排层调用 LLM + 工具，返回最终回答。
 */
ipcMain.handle('agent:chat', async (_event, { topicId, message }) => {
  try {
    // 确保 Python 执行器已启动
    if (!pythonExecutor.ready && !pythonExecutor.process) {
      pythonExecutor.start();
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Python 启动超时')), 15000);
        pythonExecutor.once('ready', () => { clearTimeout(t); resolve(); });
        pythonExecutor.once('error', (err) => { clearTimeout(t); reject(err); });
      });
    }

    const topicPath = getTopicPath(topicId);

    // 获取或初始化对话历史
    const history = getOrCreateConversation(topicId);

    // 添加用户消息
    history.push({ role: 'user', content: message });

    // 构建上下文
    const context = {
      topicId,
      topicPath,
      fileTools,
      httpTools,
      searchTools,
      pythonExecutor,
    };

    const toolCalls = [];
    let finalResponse = '';

    // 运行 Agent 循环（带实时进度推送到渲染进程）
    const result = await agent.runAgentLoop(context, history, {
      onToolCall: (name, args) => {
        toolCalls.push({ name, args: args.slice(0, 200) });
      },
      onResponse: (text) => {
        finalResponse = text;
      },
      onProgress: (event) => {
        // 通过 IPC 推送实时进度到渲染进程
        try {
          _event.sender.send('agent:progress', event);
        } catch { /* 窗口已关闭等 */ }
      },
    });

    // 压缩过长历史（超过阈值时用 LLM 摘要替代早期消息）
    const beforeTokens = agent.estimateTokens(history);
    const compressed = await agent.compressHistory(history);
    if (compressed !== history) {
      // 更新缓存中的引用
      conversationCache.set(topicId, compressed);
      const afterTokens = agent.estimateTokens(compressed);
      console.log(
        `[agent] 历史压缩: ${beforeTokens} → ${afterTokens} tokens (节省 ${Math.round((1 - afterTokens / beforeTokens) * 100)}%)`
      );
    }

    // 持久化对话历史到磁盘（以压缩后的为准）
    const historyToSave = compressed !== history ? compressed : history;
    saveConversation(topicId, historyToSave);

    return {
      success: true,
      data: {
        response: finalResponse,
        toolCalls,
        usage: result.usage[result.usage.length - 1] || null,
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * 清除 Topic 对话历史（同时清除磁盘文件和内存缓存）。
 */
ipcMain.handle('agent:clearHistory', (_event, { topicId }) => {
  conversationCache.delete(topicId);
  const filePath = getConversationPath(topicId);
  try { if (fsLib.existsSync(filePath)) fsLib.unlinkSync(filePath); } catch {}
  // 重建一个干净的对话
  const fresh = [buildSystemMessage()];
  conversationCache.set(topicId, fresh);
  saveConversation(topicId, fresh);
  return { success: true };
});

/**
 * 获取 Topic 的对话历史（供前端加载用）。返回精简版（不含 tool 消息的详细内容）。
 */
ipcMain.handle('agent:getHistory', (_event, { topicId }) => {
  try {
    const history = getOrCreateConversation(topicId);
    // 返回用户和助手消息（跳过 system 和 tool 消息的详细内容）
    const messages = history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));
    return { success: true, data: messages };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ============================================================
// 应用生命周期 — 启动 Python 执行器
// ============================================================

app.on('ready', () => {
  // 预启动 Python 执行器（在 createWindow 之后）
  setTimeout(() => {
    pythonExecutor.start();
    pythonExecutor.on('error', (err) => {
      console.error('[python-executor]', err.message);
    });
  }, 500);
});

app.on('will-quit', () => {
  pythonExecutor.shutdown().catch(() => {});
  browserTools.browserShutdown().catch(() => {});
});
