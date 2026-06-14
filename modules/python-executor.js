/**
 * Python Executor — 管理 Python 长驻子进程，通过 JSON-line 协议通信。
 *
 * 协议：
 *   Node → Python: execute / install / cancel / shutdown
 *   Python → Node: ready / stream_output / executeResult / error / shutdownAck
 *
 * 取消机制：
 *   1. 发送 cancel 请求
 *   2. 若超时未停止，kill 子进程
 *   3. kill 后自动重启执行器
 */

const { spawn } = require('child_process');
const path = require('path');
const { EventEmitter } = require('events');

const PYTHON_SCRIPT = path.join(__dirname, '..', 'python-executor', 'python-daemon.py');
const CANCEL_TIMEOUT_MS = 5000; // cancel 后等待 5 秒再 kill
const RESTART_DELAY_MS = 1000;  // kill 后 1 秒重启

class PythonExecutor extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.buffer = '';
    this.ready = false;
    this.pendingRequests = new Map(); // id → { resolve, reject, timeout }
    this.restarting = false;
  }

  /**
   * 启动 Python 子进程，等待 ready 信号。
   */
  start() {
    if (this.process) return;

    this.process = spawn('python', [PYTHON_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    });

    this.process.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.process.stderr.on('data', (chunk) => {
      // Python 进程自身的错误（非代码执行错误），转发为事件
      const text = chunk.toString();
      this.emit('python-stderr', text);
    });

    this.process.on('exit', (code) => {
      this.ready = false;
      this.emit('python-exit', code);

      // 自动重启（除非正在 shutdown）
      if (!this._shuttingDown && !this.restarting) {
        this.restarting = true;
        setTimeout(() => {
          this.restarting = false;
          this.start();
          this.emit('python-restarted');
        }, RESTART_DELAY_MS);
      }
    });

    this.process.on('error', (err) => {
      this.emit('error', err);
    });
  }

  /**
   * 优雅关闭 Python 进程。
   */
  async shutdown() {
    this._shuttingDown = true;

    if (!this.process) return;

    // 拒绝所有待处理请求
    for (const [id, { reject }] of this.pendingRequests) {
      reject(new Error('Python executor shutting down'));
      this.pendingRequests.delete(id);
    }

    this._send({ type: 'shutdown' });

    // 等待 shutdownAck 或超时
    const ackPromise = new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.once('shutdown-ack', () => {
          clearTimeout(timeout);
          resolve();
        });
      }, 3000);
      this.once('shutdown-ack', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    await ackPromise;

    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  // ============================================================
  // 公开 API
  // ============================================================

  /**
   * 执行 Python 代码。
   *
   * @param {string} code - 要执行的 Python 代码
   * @param {string} cwd - 工作目录（Topic workspace 路径）
   * @returns {Promise<{result?: string, stdout?: string, stderr?: string, error?: string, files?: string[]}>}
   */
  execute(code, cwd) {
    return this._sendRequest('execute', { code, cwd });
  }

  /**
   * 安装 Python 包。
   *
   * @param {string} packageName
   * @returns {Promise<{result: string, stdout: string}>}
   */
  install(packageName) {
    return this._sendRequest('install', { package: packageName });
  }

  /**
   * 解析文档文件（.docx / .pdf / .xlsx / .txt 等），返回提取的文本。
   *
   * @param {string} filePath - 文件的绝对路径
   * @returns {Promise<{result: string}>}
   */
  parseDocument(filePath) {
    return this._sendRequest('parse_document', { filePath });
  }

  /**
   * 取消指定请求。
   * MVP: 直接 kill + 重启，因为 Node 侧无法安全中断 Python 线程。
   *
   * @param {string} requestId
   */
  cancel(requestId) {
    this._send({ type: 'cancel', id: requestId });

    // 如果 cancel 后超时未响应，kill 进程
    const cancelTimer = setTimeout(() => {
      if (this.pendingRequests.has(requestId)) {
        const { reject } = this.pendingRequests.get(requestId);
        reject(new Error('执行已取消'));
        this.pendingRequests.delete(requestId);

        // kill 并自动重启
        if (this.process) {
          this.process.kill();
          // 重启由 exit 事件处理
        }
      }
    }, CANCEL_TIMEOUT_MS);

    // 如果请求正常完成，取消 kill 定时器
    const originalRequest = this.pendingRequests.get(requestId);
    if (originalRequest) {
      const origReject = originalRequest.reject;
      this.pendingRequests.set(requestId, {
        ...originalRequest,
        reject: (err) => {
          clearTimeout(cancelTimer);
          origReject(err);
        },
      });
    }
  }

  // ============================================================
  // 内部方法
  // ============================================================

  _send(msg) {
    if (!this.process || !this.process.stdin.writable) {
      this.emit('error', new Error('Python 进程 stdin 不可写'));
      return;
    }
    const line = JSON.stringify(msg) + '\n';
    const ok = this.process.stdin.write(line);
    if (!ok) {
      // 缓冲区满，等待 drain
      this.process.stdin.once('drain', () => {});
    }
  }

  _sendRequest(type, extra = {}) {
    return new Promise((resolve, reject) => {
      const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`请求超时: ${type} ${id}`));
      }, 120000); // 2 分钟超时

      this.pendingRequests.set(id, { resolve, reject, timeout, type });
      this._send({ type, id, ...extra });
    });
  }

  _onStdout(chunk) {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    // 保留最后一个可能不完整的行
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        this._handleMessage(msg);
      } catch {
        // 非 JSON 输出作为流式输出转发
        this.emit('raw-output', line);
      }
    }
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        this.emit('ready');
        break;

      case 'stream_output': {
        const output = { id: msg.id, stream: msg.stream, text: msg.text };
        this.emit('stream-output', output);

        // 转发给请求的调用者（用于实时显示）
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          if (!pending.streams) pending.streams = [];
          pending.streams.push(output);
        }
        break;
      }

      case 'executeResult': {
        const pending = this.pendingRequests.get(msg.id);
        if (!pending) break;

        clearTimeout(pending.timeout);
        this.pendingRequests.delete(msg.id);

        if (msg.error) {
          pending.reject(new Error(msg.error));
        } else {
          pending.resolve({
            result: msg.result,
            stdout: msg.stdout,
            stderr: msg.stderr,
            files: msg.files || [],
            streams: pending.streams || [],
          });
        }
        break;
      }

      case 'error': {
        const pending = msg.id ? this.pendingRequests.get(msg.id) : null;
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(msg.id);
          pending.reject(new Error(msg.message));
        }
        this.emit('executor-error', msg);
        break;
      }

      case 'shutdownAck':
        this.emit('shutdown-ack');
        break;

      default:
        // 忽略未知消息类型
        break;
    }
  }
}

module.exports = PythonExecutor;
