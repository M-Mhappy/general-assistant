const agent = require('./modules/agent');
const fileTools = require('./modules/file-tools');
const httpTools = require('./modules/http-tools');
const searchTools = require('./modules/search-tools');
const topicManager = require('./modules/topic-manager');
const path = require('path');
const fs = require('fs');

async function main() {
  // 清理并创建 topic
  const testDir = path.join(__dirname, 'workspace', 'topics');
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  const topic = topicManager.createTopic('新闻搜集');
  const topicPath = topicManager.getTopicPath(topic.id);

  const messages = [
    {
      role: 'system',
      content: `你是一个桌面助手。你可以搜索网页、读写文件、执行 Python。
文件操作限制在当前 workspace 内。优先使用 web_search 搜索。
当前时间：${new Date().toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}。
搜索时使用当前时间构建关键词，确保时效性。`,
    },
    { role: 'user', content: '帮我搜集本月国内外大模型热点新闻，输出为markdown文件。' },
  ];

  const context = { topicId: topic.id, topicPath, fileTools, httpTools, searchTools };

  let toolCount = 0;
  const result = await agent.runAgentLoop(context, messages, {
    onToolCall: (name, args) => {
      toolCount++;
      console.log(`\n🔧 [${toolCount}] ${name}`);
      try { console.log('   参数:', args.slice(0, 150)); } catch {}
    },
    onResponse: (text) => {
      console.log('\n📝 最终回答:\n' + text.slice(0, 500) + (text.length > 500 ? '...' : ''));
    },
  });

  // 检查生成的文件
  console.log('\n--- workspace 文件 ---');
  fileTools.listFiles(topicPath, '').forEach(f => {
    console.log(`  ${f.type === 'directory' ? '[D]' : '[F]'} ${f.name} (${f.size} B)`);
  });

  const outputFiles = fileTools.listFiles(topicPath, 'output');
  if (outputFiles.length > 0) {
    console.log('\n--- output/ 内容 ---');
    for (const f of outputFiles) {
      if (f.type === 'file') {
        console.log(`\n=== ${f.name} ===`);
        console.log(fileTools.readFile(topicPath, 'output/' + f.name).slice(0, 1500));
      }
    }
  }

  console.log('\n--- Token 统计 ---');
  const totalTokens = result.usage.reduce((s, u) => s + (u?.total_tokens || 0), 0);
  console.log(`  总 tokens: ${totalTokens}  |  工具调用: ${toolCount} 次`);

  fs.rmSync(testDir, { recursive: true, force: true });
}

main().catch(e => console.error('失败:', e.message));
