/**
 * File Tools — 文件系统工具。
 *
 * 提供安全约束下的文件操作，所有操作必须限制在指定 Topic workspace 内。
 *
 * 工具列表：
 *   list_files  — 列出目录内容
 *   read_file   — 读取文件
 *   write_file  — 写入文件（自动创建父目录）
 *   delete_file — 删除文件或空目录
 *   file_exists — 检查文件是否存在
 */

const path = require('path');
const fs = require('fs');

/**
 * 规范化路径，并校验目标路径是否在允许的 root 内。
 * 禁止 ../ 越权访问，禁止绝对路径逃逸。
 *
 * @param {string} root - 允许的根路径
 * @param {string} target - 用户请求的目标路径（相对或绝对）
 * @returns {string} 规范化后的绝对路径
 * @throws {Error} 如果路径越权
 */
function resolveSafe(root, target) {
  const normalized = path.normalize(target);

  // 拒绝仍为绝对路径且不在 root 内的情况
  if (path.isAbsolute(normalized)) {
    const resolved = path.resolve(root, '.' + normalized);
    // 确保 resolve 后仍在 root 内
    if (!resolved.startsWith(path.resolve(root) + path.sep) && resolved !== path.resolve(root)) {
      throw new Error(`路径越权: "${target}" 不在允许的 workspace 内`);
    }
    return resolved;
  }

  const resolved = path.resolve(root, normalized);

  // 解析后必须仍在 root 内
  const rootResolved = path.resolve(root);
  if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
    throw new Error(`路径越权: "${target}" 试图访问 workspace 外的路径`);
  }

  return resolved;
}

/**
 * 列出目录内容。
 *
 * @param {string} topicPath - Topic 根路径
 * @param {string} subPath - 要列出的子路径，"" 或 "." 表示根目录
 * @returns {{ name: string, type: 'file' | 'directory', size: number, mtime: string }[]}
 */
function listFiles(topicPath, subPath = '') {
  const target = resolveSafe(topicPath, subPath || '.');

  if (!fs.existsSync(target)) {
    throw new Error(`路径不存在: ${subPath || '/'}`);
  }

  const stat = fs.statSync(target);
  if (!stat.isDirectory()) {
    throw new Error(`不是目录: ${subPath || '/'}`);
  }

  const entries = fs.readdirSync(target, { withFileTypes: true });
  return entries.map((entry) => {
    const entryPath = path.join(target, entry.name);
    const entryStat = fs.statSync(entryPath);
    return {
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : 'file',
      size: entryStat.size,
      mtime: entryStat.mtime.toISOString(),
    };
  });
}

/**
 * 读取文件内容。
 *
 * @param {string} topicPath - Topic 根路径
 * @param {string} filePath - 要读取的文件相对路径
 * @returns {string} 文件文本内容
 */
function readFile(topicPath, filePath) {
  const target = resolveSafe(topicPath, filePath);

  if (!fs.existsSync(target)) {
    throw new Error(`文件不存在: ${filePath}`);
  }

  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    throw new Error(`目标路径是目录而非文件: ${filePath}`);
  }

  return fs.readFileSync(target, 'utf-8');
}

/**
 * 写入文件。若父目录不存在则自动创建。
 *
 * @param {string} topicPath - Topic 根路径
 * @param {string} filePath - 要写入的文件相对路径
 * @param {string} content - 文件内容
 */
function writeFile(topicPath, filePath, content) {
  const target = resolveSafe(topicPath, filePath);

  // 自动创建父目录
  const parent = path.dirname(target);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }

  fs.writeFileSync(target, content, 'utf-8');
}

/**
 * 删除文件或空目录。
 * MVP 只允许删除当前 Topic 内的文件。
 *
 * @param {string} topicPath - Topic 根路径
 * @param {string} filePath - 要删除的文件/目录相对路径
 */
function deleteFile(topicPath, filePath) {
  const target = resolveSafe(topicPath, filePath);

  if (!fs.existsSync(target)) {
    throw new Error(`路径不存在: ${filePath}`);
  }

  // 安全检查：禁止删除 topic 根目录本身
  if (path.resolve(target) === path.resolve(topicPath)) {
    throw new Error('不允许删除 Topic 根目录');
  }

  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    fs.rmdirSync(target); // 只删除空目录
  } else {
    fs.unlinkSync(target);
  }
}

/**
 * 检查文件或目录是否存在。
 *
 * @param {string} topicPath - Topic 根路径
 * @param {string} filePath - 相对路径
 * @returns {boolean}
 */
function fileExists(topicPath, filePath) {
  const target = resolveSafe(topicPath, filePath);
  return fs.existsSync(target);
}

/**
 * 获取文件信息（大小、修改时间等）。
 *
 * @param {string} topicPath - Topic 根路径
 * @param {string} filePath - 相对路径
 * @returns {{ name: string, type: string, size: number, mtime: string } | null}
 */
function fileStat(topicPath, filePath) {
  const target = resolveSafe(topicPath, filePath);
  if (!fs.existsSync(target)) return null;

  const stat = fs.statSync(target);
  return {
    name: path.basename(target),
    type: stat.isDirectory() ? 'directory' : 'file',
    size: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}

module.exports = {
  resolveSafe, // 导出供其他需要路径校验的模块使用
  listFiles,
  readFile,
  writeFile,
  deleteFile,
  fileExists,
  fileStat,
};
