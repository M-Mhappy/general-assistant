/**
 * Playwright 浏览器工具 — HTTP/API 不适合时的后备路径。
 *
 * MVP 工具：
 *   browser_navigate      — 打开网页
 *   browser_read_page     — 读取页面文本
 *   browser_click         — 点击元素
 *   browser_input         — 输入文本
 *   browser_scroll        — 滚动页面
 *   browser_screenshot    — 截图
 *   browser_download_file — 下载文件（通过浏览器）
 *
 * MVP 限制：
 *   - 不做自动登录
 *   - 不处理验证码
 *   - 不执行支付、下单、删除账号等敏感操作
 *   - 不做复杂视觉定位
 *
 * 浏览器实例按 topicId 绑定，支持并行预留。
 */

const path = require('path');
const fs = require('fs');

/** @type {import('playwright').Browser | null} */
let _browser = null;
let _playwright = null;

const BROWSER_STATE = new Map(); // topicId → { page, context }

// ============================================================
// 浏览器生命周期
// ============================================================

/**
 * 懒加载 Playwright 和 Chromium。
 * 如果 Playwright 未安装或浏览器未下载，抛出可读错误。
 */
async function _ensurePlaywright() {
  if (_playwright) return _playwright;

  try {
    _playwright = require('playwright');
  } catch (e) {
    throw new Error(
      'Playwright 未安装。请运行: npm install playwright && npx playwright install chromium'
    );
  }
  return _playwright;
}

async function _ensureBrowser() {
  if (_browser && _browser.isConnected()) return _browser;

  const pw = await _ensurePlaywright();
  try {
    _browser = await pw.chromium.launch({ headless: true });
  } catch (e) {
    if (e.message.includes('Executable doesn\'t exist') || e.message.includes('chromium')) {
      throw new Error(
        'Chromium 浏览器未安装。请运行: npx playwright install chromium'
      );
    }
    throw e;
  }
  return _browser;
}

/**
 * 获取或创建指定 Topic 的浏览器 page。
 */
async function _getPage(topicId) {
  const browser = await _ensureBrowser();

  let state = BROWSER_STATE.get(topicId);
  if (!state) {
    const context = await browser.newContext({
      userAgent: 'PersonalAssistant/0.1 (MVP)',
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();
    state = { context, page };
    BROWSER_STATE.set(topicId, state);
  }

  return state.page;
}

// ============================================================
// 公开工具
// ============================================================

/**
 * 导航到指定 URL。
 *
 * @param {string} topicId
 * @param {string} url
 * @returns {Promise<{ title: string, url: string }>}
 */
async function browserNavigate(topicId, url) {
  const page = await _getPage(topicId);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const title = await page.title();
  return { title, url: page.url() };
}

/**
 * 读取当前页面的纯文本内容。
 *
 * @param {string} topicId
 * @returns {Promise<string>}
 */
async function browserReadPage(topicId) {
  const page = await _getPage(topicId);
  const text = await page.evaluate(() => {
    // 移除 script 和 style
    const clone = document.body ? document.body.cloneNode(true) : document.createElement('body');
    clone.querySelectorAll('script, style, noscript').forEach((el) => el.remove());
    return clone.innerText || '';
  });
  return text;
}

/**
 * 点击页面元素。
 *
 * @param {string} topicId
 * @param {string} selector - CSS 选择器
 * @returns {Promise<{ clicked: boolean }>}
 */
async function browserClick(topicId, selector) {
  const page = await _getPage(topicId);
  try {
    await page.click(selector, { timeout: 10000 });
    return { clicked: true };
  } catch (e) {
    return { clicked: false, error: e.message };
  }
}

/**
 * 在输入框中输入文本。
 *
 * @param {string} topicId
 * @param {string} selector - 目标 input/textarea 的 CSS 选择器
 * @param {string} text - 要输入的文本
 * @returns {Promise<{ success: boolean }>}
 */
async function browserInput(topicId, selector, text) {
  const page = await _getPage(topicId);
  try {
    await page.fill(selector, text, { timeout: 10000 });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * 滚动页面。
 *
 * @param {string} topicId
 * @param {'down' | 'up'} direction
 * @param {number} [px=500] - 滚动像素
 */
async function browserScroll(topicId, direction = 'down', px = 500) {
  const page = await _getPage(topicId);
  const delta = direction === 'up' ? -px : px;
  await page.evaluate((d) => window.scrollBy(0, d), delta);
  return { scrolled: true };
}

/**
 * 截取当前页面截图，保存到 Topic workspace。
 *
 * @param {string} topicId
 * @param {string} topicPath - Topic 根路径
 * @param {string} [fileName] - 文件名，默认 screenshot-{timestamp}.png
 * @returns {Promise<{ path: string }>}
 */
async function browserScreenshot(topicId, topicPath, fileName) {
  const page = await _getPage(topicId);
  const name = fileName || `screenshot-${Date.now()}.png`;
  const savePath = path.join(topicPath, 'output', name);
  await page.screenshot({ path: savePath, fullPage: true });
  return { path: savePath };
}

/**
 * 通过浏览器下载文件（触发下载事件）。
 *
 * @param {string} topicId
 * @param {string} topicPath - Topic 根路径
 * @param {string} url - 可选：导航到此 URL 触发下载
 * @param {string} [selector] - 可选：点击此选择器触发下载
 * @returns {Promise<{ path: string, fileName: string }>}
 */
async function browserDownloadFile(topicId, topicPath, url, selector) {
  const page = await _getPage(topicId);

  // 设置下载路径
  const downloadDir = path.join(topicPath, 'downloads');
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }

  const downloadPromise = page.waitForEvent('download', { timeout: 30000 });

  if (url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
  if (selector) {
    await page.click(selector);
  }

  const download = await downloadPromise;
  const fileName = download.suggestedFilename();
  const savePath = path.join(downloadDir, fileName);
  await download.saveAs(savePath);

  return { path: savePath, fileName };
}

/**
 * 获取页面当前 URL。
 */
async function browserGetUrl(topicId) {
  const page = await _getPage(topicId);
  return page.url();
}

/**
 * 关闭指定 Topic 的浏览器上下文。
 */
async function browserCloseTopic(topicId) {
  const state = BROWSER_STATE.get(topicId);
  if (state) {
    await state.context.close();
    BROWSER_STATE.delete(topicId);
  }
}

/**
 * 关闭整个浏览器实例（应用退出时调用）。
 */
async function browserShutdown() {
  for (const [topicId] of BROWSER_STATE) {
    await browserCloseTopic(topicId);
  }
  if (_browser) {
    await _browser.close();
    _browser = null;
    _playwright = null;
  }
}

module.exports = {
  browserNavigate,
  browserReadPage,
  browserClick,
  browserInput,
  browserScroll,
  browserScreenshot,
  browserDownloadFile,
  browserGetUrl,
  browserCloseTopic,
  browserShutdown,
};
