/**
 * Topic Manager — 管理 Topic Workspace 的创建、路径解析、元信息。
 *
 * 目录结构：
 *   workspace/topics/topic_<id>/
 *     input/      — 用户上传的文件
 *     output/     — 最终生成物
 *     temp/       — 中间文件
 *     downloads/  — HTTP/下载的文件
 *     code/       — Agent 生成的代码
 *     topic.json  — 元信息
 */

const path = require('path');
const fs = require('fs');

const WORKSPACE_ROOT = path.join(__dirname, '..', 'workspace');
const TOPICS_ROOT = path.join(WORKSPACE_ROOT, 'topics');

const SUBDIRS = ['input', 'output', 'temp', 'downloads', 'code'];

/**
 * 确保 workspace 根目录存在。
 */
function ensureWorkspaceRoot() {
  if (!fs.existsSync(TOPICS_ROOT)) {
    fs.mkdirSync(TOPICS_ROOT, { recursive: true });
  }
}

/**
 * 生成简短的 topic ID。
 */
function generateTopicId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}${rand}`;
}

/**
 * 创建 Topic workspace，返回 Topic 元信息对象。
 */
function createTopic(title = '') {
  ensureWorkspaceRoot();

  const id = generateTopicId();
  const topicDir = path.join(TOPICS_ROOT, `topic_${id}`);
  const now = new Date().toISOString();

  // 创建子目录
  for (const sub of SUBDIRS) {
    fs.mkdirSync(path.join(topicDir, sub), { recursive: true });
  }

  const meta = {
    id,
    title: title || `Topic ${id}`,
    createdAt: now,
    updatedAt: now,
    status: 'active',
  };

  fs.writeFileSync(
    path.join(topicDir, 'topic.json'),
    JSON.stringify(meta, null, 2),
    'utf-8'
  );

  return meta;
}

/**
 * 获取或创建默认 Topic。
 */
function getOrCreateDefaultTopic() {
  ensureWorkspaceRoot();

  // 查找已有 active topic
  const entries = listAllTopics();
  if (entries.length > 0) {
    const first = entries[0];
    return readTopicMeta(first.id);
  }

  return createTopic();
}

/**
 * 列出所有 topic 目录。
 * 返回 [{ id, dirPath }]。
 */
function listAllTopics() {
  ensureWorkspaceRoot();

  if (!fs.existsSync(TOPICS_ROOT)) return [];

  return fs
    .readdirSync(TOPICS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('topic_'))
    .map((d) => ({
      id: d.name.replace(/^topic_/, ''),
      dirPath: path.join(TOPICS_ROOT, d.name),
    }));
}

/**
 * 读取 Topic 元信息。
 */
function readTopicMeta(topicId) {
  const metaPath = path.join(TOPICS_ROOT, `topic_${topicId}`, 'topic.json');
  if (!fs.existsSync(metaPath)) return null;

  return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
}

/**
 * 更新 Topic 元信息中的字段。
 */
function updateTopicMeta(topicId, patch) {
  const meta = readTopicMeta(topicId);
  if (!meta) return null;

  Object.assign(meta, patch, { updatedAt: new Date().toISOString() });

  const metaPath = path.join(TOPICS_ROOT, `topic_${topicId}`, 'topic.json');
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  return meta;
}

/**
 * 删除指定 Topic workspace。
 * 只允许删除 TOPICS_ROOT 下已存在的 topic_<id> 目录。
 */
function deleteTopic(topicId) {
  ensureWorkspaceRoot();

  const topic = listAllTopics().find((t) => t.id === topicId);
  if (!topic) {
    throw new Error(`Topic "${topicId}" 不存在`);
  }

  const root = path.resolve(TOPICS_ROOT);
  const target = path.resolve(topic.dirPath);
  if (!target.startsWith(root + path.sep)) {
    throw new Error(`拒绝删除越权路径: ${topicId}`);
  }

  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

/**
 * 获取 Topic workspace 根路径。
 */
function getTopicPath(topicId) {
  return path.join(TOPICS_ROOT, `topic_${topicId}`);
}

/**
 * 获取 Topic 内指定子目录路径。
 * sub 可选：'input' | 'output' | 'temp' | 'downloads' | 'code'。
 * 不传则返回 topic 根路径。
 */
function getTopicSubPath(topicId, sub) {
  if (!sub) return getTopicPath(topicId);
  return path.join(TOPICS_ROOT, `topic_${topicId}`, sub);
}

module.exports = {
  createTopic,
  getOrCreateDefaultTopic,
  listAllTopics,
  readTopicMeta,
  updateTopicMeta,
  deleteTopic,
  getTopicPath,
  getTopicSubPath,
  TOPICS_ROOT,
  SUBDIRS,
};
