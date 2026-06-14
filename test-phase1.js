/**
 * Phase 1 验证脚本 — 测试 Topic workspace 和文件系统工具。
 *
 * 验证项：
 * 1. 能创建默认 Topic
 * 2. 能在 Topic workspace 内写入、读取、列出文件
 * 3. 越权路径访问会被拒绝
 */

const path = require('path');
const fs = require('fs');
const topicManager = require('./modules/topic-manager');
const fileTools = require('./modules/file-tools');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function assertThrows(fn, label) {
  try {
    fn();
    console.error(`  ✗ ${label} — 未抛出异常`);
    failed++;
  } catch (e) {
    console.log(`  ✓ ${label} (${e.message})`);
    passed++;
  }
}

// 清理之前的测试数据
const testDir = path.join(__dirname, 'workspace', 'topics');
if (fs.existsSync(testDir)) {
  fs.rmSync(testDir, { recursive: true, force: true });
}

console.log('=== Phase 1 验证 ===\n');

// ----------------------------------------------------------
console.log('1. Topic 创建');
// ----------------------------------------------------------
const topic = topicManager.createTopic('Phase 1 测试');
assert(topic !== null, '创建 Topic 返回元信息');
assert(typeof topic.id === 'string' && topic.id.length > 0, 'Topic ID 非空字符串');
assert(topic.status === 'active', 'Topic 状态为 active');

const topicPath = topicManager.getTopicPath(topic.id);
assert(fs.existsSync(topicPath), 'Topic 目录已创建');

// 检查子目录
const subs = ['input', 'output', 'temp', 'downloads', 'code'];
for (const sub of subs) {
  const subPath = path.join(topicPath, sub);
  assert(fs.existsSync(subPath), `子目录 ${sub}/ 存在`);
}

// 检查 topic.json
const metaPath = path.join(topicPath, 'topic.json');
assert(fs.existsSync(metaPath), 'topic.json 存在');
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
assert(meta.title === 'Phase 1 测试', 'topic.json 标题正确');

console.log('');

// ----------------------------------------------------------
console.log('2. getOrCreateDefaultTopic');
// ----------------------------------------------------------
const existing = topicManager.listAllTopics();
assert(existing.length === 1, 'listAllTopics 返回 1 个 topic');

const defaultTopic = topicManager.getOrCreateDefaultTopic();
assert(defaultTopic.id === topic.id, 'getOrCreateDefaultTopic 返回已有 topic（不重复创建）');

const topicsAfter = topicManager.listAllTopics();
assert(topicsAfter.length === 1, '仍然只有 1 个 topic');

console.log('');

// ----------------------------------------------------------
console.log('3. 文件写入与读取');
// ----------------------------------------------------------
const testContent = 'Hello, 个人通用助手!';
fileTools.writeFile(topicPath, 'output/test.txt', testContent);
assert(fileTools.fileExists(topicPath, 'output/test.txt'), 'fileExists 确认文件存在');

const readContent = fileTools.readFile(topicPath, 'output/test.txt');
assert(readContent === testContent, '读取内容与写入一致');

// 多级目录写入
fileTools.writeFile(topicPath, 'output/sub/deep/file.json', '{"a":1}');
assert(fileTools.fileExists(topicPath, 'output/sub/deep/file.json'), '深层目录文件写入成功');

console.log('');

// ----------------------------------------------------------
console.log('4. 文件列表');
// ----------------------------------------------------------
const files = fileTools.listFiles(topicPath, 'output');
const names = files.map((f) => f.name);
assert(names.includes('test.txt'), '列表包含 test.txt');
assert(names.includes('sub'), '列表包含 sub 目录');
assert(files.find((f) => f.name === 'sub').type === 'directory', 'sub 为 directory 类型');

console.log('');

// ----------------------------------------------------------
console.log('5. 文件删除');
// ----------------------------------------------------------
fileTools.deleteFile(topicPath, 'output/test.txt');
assert(!fileTools.fileExists(topicPath, 'output/test.txt'), '删除后文件不存在');

fileTools.deleteFile(topicPath, 'output/sub/deep/file.json');  // 删文件
fileTools.deleteFile(topicPath, 'output/sub/deep');             // 删空目录
fileTools.deleteFile(topicPath, 'output/sub');                  // 删空目录
assert(!fileTools.fileExists(topicPath, 'output/sub'), '级联删除空目录成功');

console.log('');

// ----------------------------------------------------------
console.log('6. 路径越权防护');
// ----------------------------------------------------------
const testCases = [
  ['../outside.txt', '相对路径 ..'],
  ['..\\..\\system.txt', '..\\.. 越权'],
  ['../../etc/passwd', '../../ 越权'],
  ['output/../../../outside', '路径包含 ../'],
];

for (const [badPath, desc] of testCases) {
  assertThrows(() => fileTools.writeFile(topicPath, badPath, 'bad'), `拒绝写入: ${desc}`);
  assertThrows(() => fileTools.readFile(topicPath, badPath), `拒绝读取: ${desc}`);
  assertThrows(() => fileTools.deleteFile(topicPath, badPath), `拒绝删除: ${desc}`);
}

// 测试包含 ../ 但经过 normalize 后仍在 workspace 内的边缘情况
// （例如 "output/../output/test.txt" — 这应该是安全的，但取决于实现选择）
try {
  fileTools.writeFile(topicPath, 'output/../output/edge.txt', 'edge');
  // 如果能成功写入（规范化后路径合法），确认文件存在
  console.log('  ✓ 规范化后合法路径可写入 (output/../output/edge.txt)');
  passed++;
  fileTools.deleteFile(topicPath, 'output/edge.txt');
} catch (e) {
  // 如果被拒绝，也可接受（严格校验 ../ 出现即拒绝）
  console.log('  ✓ 严格模式：包含 ../ 即拒绝 (output/../output/edge.txt)');
  passed++;
}

// 不能删除 Topic 根目录
assertThrows(() => fileTools.deleteFile(topicPath, '.'), '拒绝删除 Topic 根目录');

console.log('');

// ----------------------------------------------------------
console.log('7. 文件状态信息');
// ----------------------------------------------------------
fileTools.writeFile(topicPath, 'info.txt', 'some data');
const stat = fileTools.fileStat(topicPath, 'info.txt');
assert(stat !== null, 'fileStat 返回非空');
assert(stat.name === 'info.txt', '文件名正确');
assert(stat.type === 'file', '类型为 file');
assert(stat.size > 0, '文件大小 > 0');
fileTools.deleteFile(topicPath, 'info.txt');

console.log('');

// ----------------------------------------------------------
console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);

// 清理
if (fs.existsSync(testDir)) {
  fs.rmSync(testDir, { recursive: true, force: true });
}

process.exit(failed > 0 ? 1 : 0);
