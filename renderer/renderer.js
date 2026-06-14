/**
 * 渲染进程脚本 — MVP 前端逻辑。
 *
 * 负责：Topic 切换、消息展示、文件列表刷新、用户输入发送。
 * 通过 window.api 与主进程通信。
 */

// ============================================================
// 状态
// ============================================================

let currentTopicId = null;

// ============================================================
// DOM 元素
// ============================================================

const $topicList = document.getElementById('topic-list');
const $topicLabel = document.getElementById('current-topic-label');
const $messages = document.getElementById('messages');
const $fileList = document.getElementById('file-list');
const $userInput = document.getElementById('user-input');
const $btnSend = document.getElementById('btn-send');
const $btnNewTopic = document.getElementById('btn-new-topic');
const $btnRefreshFiles = document.getElementById('btn-refresh-files');
const $btnUpload = document.getElementById('btn-upload');

// ============================================================
// Topic 管理
// ============================================================

async function loadTopics() {
  const result = await window.api.topic.list();
  if (!result.success) return;

  const topics = result.data;
  $topicList.innerHTML = '';

  topics.forEach((t) => {
    const li = document.createElement('li');
    li.textContent = t.meta?.title || `Topic ${t.id}`;
    li.dataset.topicId = t.id;
    li.addEventListener('click', () => selectTopic(t.id));
    if (t.id === currentTopicId) li.classList.add('active');
    $topicList.appendChild(li);
  });
}

async function selectTopic(topicId) {
  currentTopicId = topicId;
  $topicLabel.textContent = `当前 Topic: ${topicId}`;
  loadTopics();           // 刷新 active 样式
  refreshFileList();

  // 清空消息区，加载该 Topic 的历史记录
  $messages.innerHTML = '';
  await loadConversationHistory(topicId);
}

async function ensureTopic() {
  const result = await window.api.topic.getOrCreate();
  if (result.success) {
    currentTopicId = result.data.id;
    $topicLabel.textContent = `当前 Topic: ${currentTopicId}`;
    await loadTopics();
    await refreshFileList();
    await loadConversationHistory(currentTopicId);
  }
}

/**
 * 加载并显示指定 Topic 的对话历史。
 */
async function loadConversationHistory(topicId) {
  try {
    const result = await window.api.agent.getHistory(topicId);
    if (result.success && result.data.length > 0) {
      result.data.forEach((m) => {
        if (m.role === 'user') {
          addMessage('user', m.content);
        } else if (m.role === 'assistant' && m.content) {
          addMessage('assistant', m.content);
        }
      });
    } else {
      // 全新 Topic，显示欢迎信息
      addNotice('欢迎使用个人通用助手！输入你的请求开始。');
      addNotice('提示: /file ls 可查看文件，/clear 清除对话。');
    }
  } catch {
    addNotice('欢迎使用个人通用助手！输入你的请求开始。');
  }
}

$btnNewTopic.addEventListener('click', async () => {
  const result = await window.api.topic.create();
  if (result.success) {
    await selectTopic(result.data.id);
    await loadTopics();
  }
});

// ============================================================
// 消息展示
// ============================================================

/**
 * 简易 Markdown 渲染：处理代码块和行内代码。
 */
function simpleMarkdown(text) {
  let html = text
    // 转义 HTML
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

    // 代码块 ``` ... ```
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="code-block"><code>$2</code></pre>')

    // 行内代码 `...`
    .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')

    // 粗体 **...**
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')

    // 换行
    .replace(/\n/g, '<br>');

  return html;
}

function addMessage(role, text, label) {
  const div = document.createElement('div');
  div.className = `message ${role}`;

  if (label) {
    const lbl = document.createElement('div');
    lbl.className = 'label';
    lbl.textContent = label;
    div.appendChild(lbl);
  }

  const body = document.createElement('div');
  if (role === 'assistant') {
    body.innerHTML = simpleMarkdown(text);
  } else {
    body.textContent = text;
  }
  div.appendChild(body);

  $messages.appendChild(div);
  $messages.scrollTop = $messages.scrollHeight;
}

/**
 * 显示一条系统通知（非对话消息）。
 */
function addNotice(text) {
  const div = document.createElement('div');
  div.className = 'message notice';
  div.textContent = text;
  $messages.appendChild(div);
  $messages.scrollTop = $messages.scrollHeight;
}

// ============================================================
// 文件列表
// ============================================================

let currentViewPath = ''; // 文件列表中当前浏览的子路径

async function refreshFileList(subPath) {
  if (subPath !== undefined) currentViewPath = subPath;
  const viewPath = currentViewPath || '';

  if (!currentTopicId) {
    $fileList.innerHTML = '<li style="color:var(--text-muted)">—</li>';
    return;
  }

  const result = await window.api.file.list(currentTopicId, viewPath);
  if (!result.success) {
    $fileList.innerHTML = `<li style="color:var(--danger)">${result.error}</li>`;
    return;
  }

  $fileList.innerHTML = '';

  // 如果在子目录中，显示返回上级
  if (viewPath) {
    const backLi = document.createElement('li');
    backLi.className = 'file-nav-back';
    backLi.innerHTML = '<span class="file-icon">📂</span> .. (上级目录)';
    backLi.addEventListener('click', () => {
      const parent = viewPath.split('/').slice(0, -1).join('/') || '';
      refreshFileList(parent);
    });
    $fileList.appendChild(backLi);
  }

  const files = result.data;
  const sorted = [
    ...files.filter((f) => f.type === 'directory'),
    ...files.filter((f) => f.type === 'file'),
  ];

  if (sorted.length === 0 && !viewPath) {
    $fileList.innerHTML = '<li style="color:var(--text-muted)">空</li>';
    return;
  }

  sorted.forEach((f) => {
    const li = document.createElement('li');
    const icon = f.type === 'directory' ? '📁' : '📄';
    const childPath = viewPath ? `${viewPath}/${f.name}` : f.name;

    li.innerHTML = `
      <span class="file-icon">${icon}</span>
      <span class="file-name">${f.name}</span>
      ${f.type === 'file' ? `
        <span class="file-actions">
          <button class="btn-download" title="用默认程序打开">📥</button>
          <button class="btn-delete" title="删除文件">🗑</button>
        </span>
      ` : ''}
    `;

    if (f.type === 'directory') li.classList.add('file-dir');
    li.title = `${f.name}\n类型: ${f.type}\n大小: ${f.size} B\n修改: ${f.mtime}`;

    // 点击文件名 → 预览 / 进入目录
    li.addEventListener('click', (e) => {
      // 如果点击的是按钮则不触发
      if (e.target.tagName === 'BUTTON') return;
      if (f.type === 'directory') {
        refreshFileList(childPath);
      } else {
        previewFile(childPath);
      }
    });

    // 下载按钮：用系统默认程序打开
    if (f.type === 'file') {
      li.querySelector('.btn-download').addEventListener('click', async (e) => {
        e.stopPropagation();
        await downloadFile(childPath);
      });

      // 删除按钮：删除文件
      li.querySelector('.btn-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`确定要删除 "${f.name}" 吗？`)) {
          const res = await window.api.file.delete(currentTopicId, childPath);
          if (res.success) {
            addNotice(`已删除: ${f.name}`);
            refreshFileList(viewPath);
          } else {
            addNotice(`删除失败: ${res.error}`);
          }
        }
      });
    }

    $fileList.appendChild(li);
  });
}

/**
 * 预览文件内容（在消息区显示）。
 */
async function previewFile(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  const textExts = ['txt', 'md', 'json', 'csv', 'html', 'css', 'js', 'py', 'xml', 'yaml', 'yml', 'log', 'sh', 'bat', 'ini', 'cfg'];
  const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp'];

  if (imageExts.includes(ext)) {
    addMessage('assistant', `[图片文件] ${filePath}\n（MVP 暂不支持图片预览，可在文件管理器中打开）`, `file:${filePath}`);
    return;
  }

  const result = await window.api.file.read(currentTopicId, filePath);
  if (result.success) {
    const content = result.data;
    const truncated = content.length > 5000 ? '\n\n...(内容过长，已截断)' : '';
    const display = content.slice(0, 5000) + truncated;
    const langMap = { md: 'markdown', js: 'javascript', py: 'python', json: 'json', html: 'html', css: 'css' };
    const lang = langMap[ext] || '';
    const codeBlock = '```' + lang + '\n' + display + '\n```';
    addMessage('assistant', codeBlock, `📄 ${filePath} (${content.length} 字符)`);
  } else {
    addMessage('assistant', `❌ 无法读取: ${result.error}`, `file:${filePath}`);
  }
}

/**
 * 用系统默认程序打开文件（"下载"到本地应用）。
 */
async function downloadFile(filePath) {
  const result = await window.api.file.open(currentTopicId, filePath);
  if (result.success) {
    addNotice(`已打开: ${filePath}`);
  } else {
    addNotice(`打开失败: ${result.error}`);
  }
}

$btnRefreshFiles.addEventListener('click', () => refreshFileList(''));

$btnUpload.addEventListener('click', handleUpload);

/**
 * 处理文件上传：打开系统文件选择对话框，复制到 input/ 目录。
 */
async function handleUpload() {
  if (!currentTopicId) {
    addNotice('请先选择一个 Topic');
    return;
  }

  $btnUpload.disabled = true;
  try {
    const result = await window.api.file.upload(currentTopicId);
    if (result.success) {
      const files = result.data;
      if (files.length === 0) {
        // 用户取消了选择
      } else {
        const fileList = files.join(', ');
        addNotice(`已上传 ${files.length} 个文件: ${fileList}`);
        refreshFileList('');
      }
    } else {
      addNotice(`上传失败: ${result.error}`);
    }
  } catch (err) {
    addNotice(`上传异常: ${err.message}`);
  } finally {
    $btnUpload.disabled = false;
  }
}

// ============================================================
// 用户输入 — Agent 集成（流式进度版）
// ============================================================

$btnSend.addEventListener('click', handleSend);
$userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

let isProcessing = false;

// 流式输出状态
let currentToolChain = null;    // 本轮工具链容器 DOM
let currentToolCards = {};      // cardId -> { card, name }
let currentStreamMsg = null;    // 流式助手消息 DOM
let currentStreamText = '';     // 流式文本累积
let progressCleanup = null;     // 进度监听清理函数
let streamingHandled = false;   // 流式是否已触发 done 事件
let streamHadText = false;      // 流式是否产生了可见文本（不受 finalizeStream 影响）

/**
 * HTML 转义工具函数。
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 创建工具链容器。
 */
function createToolChain() {
  const div = document.createElement('div');
  div.className = 'tool-chain';
  $messages.appendChild(div);
  return div;
}

/**
 * 添加 LLM 轮次标记。
 */
function addIterationBadge(chain, iteration) {
  const badge = document.createElement('div');
  badge.className = 'iter-badge';
  badge.textContent = `🔄 第 ${iteration} 轮`;
  chain.appendChild(badge);
  $messages.scrollTop = $messages.scrollHeight;
}

/**
 * 添加工具卡片（执行中状态）。
 */
function addToolCard(chain, event) {
  const cardId = `${event.name}_${Date.now()}`;
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.id = 'tool-' + cardId;

  // 提取人类可读的参数摘要
  let argsPreview = '';
  try {
    const parsed = JSON.parse(event.args);
    if (parsed.query) argsPreview = parsed.query;
    else if (parsed.url) argsPreview = parsed.url;
    else if (parsed.filePath) argsPreview = parsed.filePath;
    else if (parsed.code) argsPreview = parsed.code.split('\n')[0].slice(0, 80);
    else argsPreview = event.args.slice(0, 100);
  } catch {
    argsPreview = event.args.slice(0, 100);
  }

  card.innerHTML = `
    <div class="tool-card-header">
      <span class="tool-toggle">▼</span>
      <span class="tool-icon">🔧</span>
      <span class="tool-name">${escapeHtml(event.name)}</span>
      <span class="tool-args-preview">${escapeHtml(argsPreview)}</span>
      <span class="tool-status running">⏳</span>
    </div>
    <div class="tool-card-body">
      <div class="tool-args-full"><code>${escapeHtml(event.args.slice(0, 500))}</code></div>
      <div class="tool-result">等待结果...</div>
    </div>
  `;

  // 折叠/展开
  card.querySelector('.tool-card-header').addEventListener('click', () => {
    card.classList.toggle('collapsed');
  });

  chain.appendChild(card);
  currentToolCards[cardId] = { card, name: event.name };
  $messages.scrollTop = $messages.scrollHeight;
}

/**
 * 更新工具卡片（执行完成）。
 */
function updateToolCard(event) {
  // 查找最近一个匹配名称且仍在运行的卡片
  const entries = Object.entries(currentToolCards);
  for (let i = entries.length - 1; i >= 0; i--) {
    const [cardId, info] = entries[i];
    if (info.name !== event.name) continue;
    const statusEl = info.card.querySelector('.tool-status');
    if (!statusEl || !statusEl.classList.contains('running')) continue;

    const resultEl = info.card.querySelector('.tool-result');

    if (event.error) {
      statusEl.className = 'tool-status error';
      statusEl.textContent = '❌ 失败';
      resultEl.className = 'tool-result error';
      resultEl.textContent = event.error;
    } else {
      statusEl.className = 'tool-status done';
      statusEl.textContent = '✓';
      resultEl.className = 'tool-result';

      // parse_file / read_file 等读取类工具，只显示摘要统计，不重复展示全文内容
      // （全文内容由 LLM 在回答中呈现，工具卡片仅显示状态）
      if (event.name === 'parse_file' || event.name === 'read_file') {
        const resultText = event.result || '';
        const charCount = resultText.length;
        const lineCount = resultText ? resultText.split('\n').length : 0;
        resultEl.textContent = `已读取 ${charCount} 字符，约 ${lineCount} 行`;
      } else {
        const resultText = event.result || '(空)';
        resultEl.textContent = resultText.length > 2000
          ? resultText.slice(0, 2000) + '... (已截断)'
          : resultText;
      }
    }

    // 完成后自动折叠
    info.card.classList.add('collapsed');
    $messages.scrollTop = $messages.scrollHeight;
    break;
  }
}

/**
 * 创建流式助手消息 DOM。
 */
function createStreamMessage() {
  const div = document.createElement('div');
  div.className = 'message assistant';
  const body = document.createElement('div');
  body.className = 'stream-body';
  div.appendChild(body);
  $messages.appendChild(div);
  currentStreamText = '';
  return div;
}

/**
 * 追加流式文本增量。
 */
function appendStreamText(msgDiv, text) {
  currentStreamText += text;
  msgDiv.querySelector('.stream-body').textContent = currentStreamText;
  $messages.scrollTop = $messages.scrollHeight;
}

/**
 * 完成流式输出，将文本渲染为 Markdown。
 */
function finalizeStream() {
  if (currentStreamMsg) {
    const body = currentStreamMsg.querySelector('.stream-body');
    body.innerHTML = simpleMarkdown(currentStreamText);
    currentStreamMsg = null;
    currentStreamText = '';
  }
  currentToolChain = null;
  currentToolCards = {};
}

/**
 * 处理来自主进程的实时进度事件。
 */
function handleProgress(event) {
  switch (event.type) {
    case 'llm_request':
      if (!currentToolChain) currentToolChain = createToolChain();
      addIterationBadge(currentToolChain, event.iteration);
      break;

    case 'tool_start':
      if (!currentToolChain) currentToolChain = createToolChain();
      addToolCard(currentToolChain, event);
      break;

    case 'tool_end':
      updateToolCard(event);
      break;

    case 'text_delta':
      if (!currentStreamMsg) currentStreamMsg = createStreamMessage();
      appendStreamText(currentStreamMsg, event.text);
      streamHadText = true;
      break;

    case 'done':
      finalizeStream();
      streamingHandled = true;
      break;

    case 'error':
      addNotice(`⚠️ ${event.message}`);
      break;
  }
}

async function handleSend() {
  const text = $userInput.value.trim();
  if (!text || isProcessing) return;
  $userInput.value = '';

  addMessage('user', text);

  // 本地快捷命令（无需经过 LLM）
  if (text.startsWith('/file ')) {
    await handleFileCommand(text.slice(6));
    return;
  }

  if (text.startsWith('/search ') || text.startsWith('/s ')) {
    const query = text.startsWith('/search ') ? text.slice(8) : text.slice(3);
    await handleSearchCommand(query);
    return;
  }

  if (text === '/clear') {
    $messages.innerHTML = '';
    await window.api.agent.clearHistory(currentTopicId);
    addNotice('对话历史已清除。');
    return;
  }

  // 重置流式状态
  currentToolChain = null;
  currentToolCards = {};
  currentStreamMsg = null;
  currentStreamText = '';
  streamingHandled = false;
  streamHadText = false;

  // 设置进度监听
  progressCleanup = window.api.agent.onProgress(handleProgress);

  isProcessing = true;
  $btnSend.disabled = true;
  $btnSend.textContent = '…';
  setAgentStatus('warn', '🟡 处理中…');

  try {
    const result = await window.api.agent.chat(currentTopicId, text);

    // 清理进度监听
    if (progressCleanup) { progressCleanup(); progressCleanup = null; }

    if (result.success) {
      setAgentStatus('ok', '🟢 就绪');

      // 如果流式输出已产生可见文本，不再重复显示
      // 若流式未能产生文本（API 未返回 text_delta），回退到直接显示
      if (!streamHadText) {
        finalizeStream();
        addMessage('assistant', result.data.response || '(无回答)');
      }

      refreshFileList();
    } else {
      setAgentStatus('warn', '⚠️ 错误');
      finalizeStream();
      addMessage('assistant', `❌ 错误: ${result.error}`);
    }
  } catch (err) {
    if (progressCleanup) { progressCleanup(); progressCleanup = null; }
    setAgentStatus('warn', '⚠️ 连接失败');
    finalizeStream();
    addMessage('assistant', `❌ 通信异常: ${err.message}`);
  } finally {
    isProcessing = false;
    $btnSend.disabled = false;
    $btnSend.textContent = '发送';
  }
}

/**
 * 本地文件快捷命令（不经过 LLM，直接操作文件系统）。
 */
async function handleFileCommand(cmd) {
  const parts = cmd.trim().split(/\s+/);
  const action = parts[0];
  const arg = parts[1];

  try {
    switch (action) {
      case 'ls': {
        const subPath = arg || '';
        const res = await window.api.file.list(currentTopicId, subPath);
        if (res.success) {
          const names = res.data.map((f) => `${f.type === 'directory' ? '[D]' : '[F]'} ${f.name}`).join('\n');
          addMessage('assistant', `文件列表:\n${names || '(空)'}`, 'file:list');
        } else {
          addMessage('assistant', `错误: ${res.error}`, 'file:list');
        }
        break;
      }
      case 'read': {
        if (!arg) { addMessage('assistant', '用法: /file read <路径>'); break; }
        const res = await window.api.file.read(currentTopicId, arg);
        if (res.success) {
          addMessage('assistant', res.data.slice(0, 2000), `file:read ${arg}`);
        } else {
          addMessage('assistant', `错误: ${res.error}`, 'file:read');
        }
        break;
      }
      default:
        addMessage('assistant', `支持的命令: ls / read`);
    }
  } catch (err) {
    addMessage('assistant', `异常: ${err.message}`);
  }
}

/**
 * 搜索快捷命令（不经过 LLM，直接调搜索 API）。
 */
async function searchCommand(query) {
  if (!query) {
    addMessage('assistant', '用法: /search <关键词>');
    return;
  }

  addMessage('tool-summary', `🔍 搜索: ${query}`, '搜索');
  try {
    const result = await window.api.search.web(query);
    if (result.success) {
      addMessage('assistant', result.data);
    } else {
      addMessage('assistant', `搜索失败: ${result.error}`);
    }
  } catch (err) {
    addMessage('assistant', `搜索异常: ${err.message}`);
  }
}

// We need to fix the function name reference — in handleSearchCommand above
// Let's also fix the function body to match
// (keeping both for backward compatibility)
async function handleSearchCommand(query) {
  return searchCommand(query);
}

// ============================================================
// 状态栏
// ============================================================

const $statusAgent = document.getElementById('status-agent');

function setAgentStatus(status, text) {
  const classes = { ok: 'ok', warn: 'warn', off: '' };
  $statusAgent.className = classes[status] || '';
  $statusAgent.textContent = text;
}

// ============================================================
// 启动
// ============================================================

ensureTopic().then(() => {
  setAgentStatus('ok', '🟢 就绪');
});

