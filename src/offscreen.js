import { MESSAGE } from './shared/constants.js';

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function createObjectUrl(transfer, transferId) {
  try {
    const orderedChunks = [...transfer.chunks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map((entry) => entry[1]);
    if (transfer.receivedSize !== transfer.expectedSize) {
      throw new Error(`下载数据不完整：${transfer.receivedSize}/${transfer.expectedSize}`);
    }
    const blob = new Blob(orderedChunks, { type: transfer.mime });
    const objectUrl = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 120000);
    return objectUrl;
  } finally {
    transfer.transfers.delete(transferId);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'zhihu-exporter-download') return;
  const transfers = new Map();

  port.onMessage.addListener((message) => {
    const respond = (payload) => port.postMessage({ requestId: message.requestId, ...payload });
    (async () => {
      if (message.type === MESSAGE.OFFSCREEN_DOWNLOAD_BEGIN) {
        transfers.set(message.transferId, {
          mime: message.mime,
          expectedSize: message.size,
          receivedSize: 0,
          chunks: new Map(),
          transfers
        });
        respond({ ok: true });
        return;
      }

      if (message.type === MESSAGE.OFFSCREEN_DOWNLOAD_CHUNK) {
        const transfer = transfers.get(message.transferId);
        if (!transfer) throw new Error('下载传输状态不存在');
        const bytes = base64ToBytes(message.data);
        if (!transfer.chunks.has(message.index)) transfer.receivedSize += bytes.length;
        transfer.chunks.set(message.index, bytes);
        respond({ ok: true });
        return;
      }

      if (message.type === MESSAGE.OFFSCREEN_DOWNLOAD_END) {
        const transfer = transfers.get(message.transferId);
        if (!transfer) throw new Error('下载传输状态不存在');
        const objectUrl = createObjectUrl(transfer, message.transferId);
        respond({ ok: true, objectUrl });
        return;
      }

      throw new Error(`未知离屏消息类型：${message.type}`);
    })().catch((error) => respond({ ok: false, error: error.message || String(error) }));
  });

  port.onDisconnect.addListener(() => transfers.clear());
});
