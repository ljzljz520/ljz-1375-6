// 全局配置：站点固定 UTC+8；数据新鲜度（来源公告更新频率）用于标记“最后核对时间”与过期。
export const SITE_OFFSET_MIN = 8 * 60;
export const PORT = Number(process.env.PORT || 8080);
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'beacon-admin-token';

// 各类条件在没有更新公告时视为“陈旧/不可据此下结论”的阈值（秒）
export const FRESHNESS_SECONDS = {
  boat: 12 * 3600,
  weather: 6 * 3600,
  tide: 24 * 3600,
  venue: 24 * 3600,
};

// 预计算计划的失效策略：公告写入代次后，旧计划版本立即失效（保守失效）
export const PLAN_CACHE_STRATEGY = 'invalidate-on-generation';

// 离线包有效期（秒）：包内资料只在该期限内可作为“截至生成时”的参考
export const OFFLINE_PACK_TTL_SECONDS = 48 * 3600;

// 客户端时钟偏差告警阈值（秒）
export const CLOCK_WARN_SKEW_SECONDS = 60;
