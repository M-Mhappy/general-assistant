/**
 * Preload 脚本 — 通过 contextBridge 安全暴露 API 给渲染进程。
 *
 * 渲染进程只能调用此处暴露的方法，不能直接访问 Node.js API。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ---- Topic ----
  topic: {
    getOrCreate: () => ipcRenderer.invoke('topic:getOrCreate'),
    create: (title) => ipcRenderer.invoke('topic:create', title),
    list: () => ipcRenderer.invoke('topic:list'),
    getMeta: (topicId) => ipcRenderer.invoke('topic:getMeta', topicId),
    delete: (topicId) => ipcRenderer.invoke('topic:delete', { topicId }),
  },

  // ---- File Tools ----
  file: {
    list: (topicId, subPath) =>
      ipcRenderer.invoke('file:list', { topicId, subPath }),
    read: (topicId, filePath) =>
      ipcRenderer.invoke('file:read', { topicId, filePath }),
    preview: (topicId, filePath) =>
      ipcRenderer.invoke('file:preview', { topicId, filePath }),
    write: (topicId, filePath, content) =>
      ipcRenderer.invoke('file:write', { topicId, filePath, content }),
    delete: (topicId, filePath) =>
      ipcRenderer.invoke('file:delete', { topicId, filePath }),
    exists: (topicId, filePath) =>
      ipcRenderer.invoke('file:exists', { topicId, filePath }),
    getPath: (topicId, filePath) =>
      ipcRenderer.invoke('file:getPath', { topicId, filePath }),
    open: (topicId, filePath) =>
      ipcRenderer.invoke('file:open', { topicId, filePath }),
    upload: (topicId) =>
      ipcRenderer.invoke('file:upload', { topicId }),
    parse: (topicId, filePath) =>
      ipcRenderer.invoke('file:parse', { topicId, filePath }),
  },

  // ---- Search ----
  search: {
    web: (query, maxResults) =>
      ipcRenderer.invoke('search:web', { query, maxResults }),
  },

  // ---- Browser Tools ----
  browser: {
    navigate: (topicId, url) =>
      ipcRenderer.invoke('browser:navigate', { topicId, url }),
    readPage: (topicId) =>
      ipcRenderer.invoke('browser:readPage', { topicId }),
    click: (topicId, selector) =>
      ipcRenderer.invoke('browser:click', { topicId, selector }),
    input: (topicId, selector, text) =>
      ipcRenderer.invoke('browser:input', { topicId, selector, text }),
    scroll: (topicId, direction, px) =>
      ipcRenderer.invoke('browser:scroll', { topicId, direction, px }),
    screenshot: (topicId, fileName) =>
      ipcRenderer.invoke('browser:screenshot', { topicId, fileName }),
    downloadFile: (topicId, url, selector) =>
      ipcRenderer.invoke('browser:downloadFile', { topicId, url, selector }),
  },

  // ---- Agent ----
  agent: {
    chat: (topicId, message) =>
      ipcRenderer.invoke('agent:chat', { topicId, message }),
    clearHistory: (topicId) =>
      ipcRenderer.invoke('agent:clearHistory', { topicId }),
    getHistory: (topicId) =>
      ipcRenderer.invoke('agent:getHistory', { topicId }),
    /**
     * 监听 Agent 实时进度事件。返回清理函数。
     * @param {function} callback - (event) => void
     * @returns {function} 调用后取消监听
     */
    onProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('agent:progress', handler);
      return () => ipcRenderer.removeListener('agent:progress', handler);
    },
  },

  // ---- HTTP/API Tools ----
  http: {
    get: (url, options) =>
      ipcRenderer.invoke('http:get', { url, options }),
    post: (url, body, options) =>
      ipcRenderer.invoke('http:post', { url, body, options }),
    download: (topicId, url, fileName) =>
      ipcRenderer.invoke('http:download', { topicId, url, fileName }),
    parseHtml: (html) =>
      ipcRenderer.invoke('http:parseHtml', { html }),
    saveResponse: (topicId, data, filePath, format) =>
      ipcRenderer.invoke('http:saveResponse', { topicId, data, filePath, format }),
  },
});
