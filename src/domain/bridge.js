// 桥接：为路线逐航段评估复用条件域的“公告 -> 声明”展开，保持单一事实来源。
import { activeNotices } from './notices.js';
import { claimsFromNotices } from './conditions.js';

export function claimsFromNoticesBridge(topic, window, { resourceId = null } = {}) {
  return claimsFromNotices(activeNotices(window, { topic, resourceId: resourceId || undefined }), window);
}
