import { MESSAGE } from '../shared/constants.js';
import { isArticlePageUrl } from '../shared/utils.js';

const queueState = document.getElementById('queue-state');
const message = document.getElementById('message');
const pause = document.getElementById('pause');
const resume = document.getElementById('resume');
let currentTab = null;

function sendRuntime(messagePayload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(messagePayload, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (!response?.ok) reject(new Error(response?.error || '操作失败'));
      else resolve(response);
    });
  });
}

function setMessage(text, type = '') {
  message.textContent = text;
  message.className = `message ${type}`.trim();
}

async function getCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function loadState() {
  try {
    const dashboard = await sendRuntime({ type: MESSAGE.GET_DASHBOARD_STATE });
    const queue = dashboard.queue || {};
    queueState.textContent = queue.paused ? `队列已暂停，运行 ${queue.activeCount || 0} 个` : `队列运行中，运行 ${queue.activeCount || 0} 个`;
    pause.disabled = Boolean(queue.paused);
    resume.disabled = !queue.paused;
  } catch (error) {
    queueState.textContent = '无法读取队列状态';
    setMessage(error.message, 'error');
  }
}

async function triggerExport(format) {
  if (!currentTab?.id || !isArticlePageUrl(currentTab.url)) {
    setMessage('当前页面不是支持的文章或回答页面。', 'error');
    return;
  }
  try {
    const response = await chrome.tabs.sendMessage(currentTab.id, { type: MESSAGE.TRIGGER_EXPORT, format });
    if (!response?.ok) throw new Error('页面下载按钮尚未准备好，请刷新页面后重试');
    setMessage('已触发导出，请查看浏览器下载和任务管理器。', 'success');
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

document.getElementById('open-manager').addEventListener('click', async () => {
  await sendRuntime({ type: MESSAGE.OPEN_MANAGER });
  window.close();
});

for (const button of document.querySelectorAll('[data-format]')) {
  button.addEventListener('click', () => triggerExport(button.dataset.format));
}

pause.addEventListener('click', async () => {
  await sendRuntime({ type: MESSAGE.PAUSE_QUEUE });
  await loadState();
});

resume.addEventListener('click', async () => {
  await sendRuntime({ type: MESSAGE.RESUME_QUEUE });
  await loadState();
});

(async () => {
  currentTab = await getCurrentTab();
  const exportable = isArticlePageUrl(currentTab?.url || '');
  for (const button of document.querySelectorAll('[data-format]')) button.disabled = !exportable;
  if (!exportable) setMessage('打开知乎文章或回答页面后可使用快速导出。');
  await loadState();
})();
