# 🗼 灯塔旅行指南

Web 查看灯塔历史、船班与登岛窗口；管理 API 导入**经确认**的公告；数据库保存每条公告的
**来源时间、适用日期（半开时间区间）与内容代次**。船班、天气、潮汐、场所开放是四类**互相独立**
的条件，任何单一条件成立都不能推出“可登岛”；数据不足或互相冲突时一律保留**未知**。

## 运行

```bash
node scripts/seed.js        # 生成演示数据（以运行当天为 D0 的相对日期）
npm start                   # http://localhost:8080
npm test                    # 26 个单元/端到端测试
# 管理令牌默认 beacon-admin-token（可用环境变量 ADMIN_TOKEN 覆盖）
```

## 页面标签

| 标签 | 内容 |
|---|---|
| 登岛窗口 | 指定日综合判定；标明船班/天气/潮汐/场所各自**最后核对时间**与陈旧标记 |
| 船班/天气/潮汐/场所 | 自定义时间窗口，逐段（TRUE/FALSE/UNKNOWN/CONFLICT）展示 |
| 已审路线核对 | 只允许已审核路线；航段计划窗口与用户选择窗口**时间区间求交** |
| 守塔人历史 | 独立内容流，各自带核对时间，临时取消不使其失效 |
| 收藏与重连 | 保存快照；重连后逐字段/逐场所展示**变化前后** |
| 离线包 | 生成带有效期的离线包；可模拟离线/过期；明确非安全/交通保证 |
| 预计算 vs 实时 | 后台日期计划与请求时组合约束对比（代次、stale、耗时） |
| 管理导入 | 导入 confirmed 公告、重复船班去重、拒绝未确认公告 |

顶栏提供 **客户端时钟演练**（-1h / +2h），所有“现在/过期/核对时间”判断都以服务器时间为准。
打印（`window.print()`，页面也有打印按钮）时页脚附带**资料有效期与未确定事项**。

## 关键 HTTP 接口

只读：`GET /api/time`、`/api/landing`、`/api/conditions/{boat,weather,tide,venue}`、
`/api/notices`、`/api/history`、`/api/routes`、`/api/routes/check`、
`/api/plans`、`/api/plans/compare`、`/api/favorites`、`/api/offline/pack`

管理（`X-Admin-Token`）：`POST /api/admin/notices`（单条或数组，仅接受 `status:"confirmed"`）、
`POST /api/admin/precompute`、`GET /api/admin/stats`

## 判定规则（三值逻辑）

* 每类条件按公告边界把查询窗口切成基本段：无数据 `UNKNOWN`、仅正向 `TRUE`、仅负向 `FALSE`。
* 正反对撞：更窄的“临时”声明挖洞（临时取消/临时关闭优先）；等宽且**跨来源**无法调和为 `CONFLICT`；
  同一来源同窗口的“取消 vs 班期”视为修正，安全侧取 `FALSE`。
* 来源时间超过 TTL（船班 12h、天气 6h、潮汐/场所 24h）→ 降级 `UNKNOWN`。
* 综合结论：四类全 `TRUE` 才 `LANDING_POSSIBLE`；任一 `FALSE` → `NO_LANDING`；其余（含 MIXED/CONFLICT/
  陈旧/缺失）→ `UNKNOWN`。

设计细节与取舍见 [DESIGN.md](./DESIGN.md)。
