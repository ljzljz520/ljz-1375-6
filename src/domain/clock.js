// 客户端时钟纠偏：不信任客户端本地时间，类 NTP：用服务器 Date 校正客户端时钟偏差。
// |skew| 超阈值时页面给出明显告警，且“最后核对时间/离线过期”一律以服务器时间为准。
import { CLOCK_WARN_SKEW_SECONDS } from '../config.js';

export function serverNow(resOrObj) {
  return Date.now();
}

/**
 * @param clientTimeMs 客户端自报时间
 * @param serverTimeMs 服务器接收时时间
 */
export function assessClock(clientTimeMs, serverTimeMs = Date.now()) {
  if (!Number.isFinite(clientTimeMs)) {
    return { clientTime: null, serverTime: serverTimeMs, skewSeconds: null, trusted: false, correctedNow: serverTimeMs, warning: '缺少客户端时间，已全部改用服务器时间' };
  }
  const skewSeconds = Math.round((clientTimeMs - serverTimeMs) / 1000);
  const trusted = Math.abs(skewSeconds) <= CLOCK_WARN_SKEW_SECONDS;
  return {
    clientTime: clientTimeMs,
    serverTime: serverTimeMs,
    skewSeconds,
    trusted,
    correctedNow: serverTimeMs, // 业务判定始终使用该值
    warning: trusted ? null : `客户端时钟偏差 ${skewSeconds}s，已忽略客户端时钟并采用服务器时间`,
  };
}
