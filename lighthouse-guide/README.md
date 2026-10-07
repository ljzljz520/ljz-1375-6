# 灯塔旅行指南

Web 查看灯塔历史、船班与登岛窗口;管理 API 导入经确认的公告;数据库保存来源时间、
适用日期与内容代次。船班/天气/潮汐/场所开放四条件缺一或冲突时,结论保留「未知」。

## 运行

```bash
cd lighthouse-guide
python3 -m app.seed lighthouse.db        # 初始化+种子数据(首次)
python3 -m app.api lighthouse.db         # 启动 http://localhost:5000
```

页面:`/` 指南首页(历史/船班/登岛窗口) · `/plan` 我的计划(路线检查/收藏/重连对比/离线包)
· `/print/<plan_id>` 打印页(资料有效期+未确定事项+免责声明)

## 测试

```bash
python3 -m pytest tests/ -q
```

11 项验收:重复船班通知幂等、跨日潮汐求交、观景点临时关闭影响路线、客户端时钟不准
(服务器时间为准)、离线过期(时间+代次)、单条件不给结论、冲突保留未知、取消不影响
守塔人资料、预计算失效与实时对比、计划重连前后对比、未确认公告拒收。

## API 摘要

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/admin/announcements` | 导入经确认公告(幂等;拒绝未确认) |
| POST | `/api/admin/precompute` | 后台预计算某日计划 |
| GET | `/api/landing?date=&mode=` | 登岛窗口:realtime / precomputed / compare |
| GET | `/api/conditions?date=` | 四条件状态+各自最后核对时间 |
| GET | `/api/ships?date=` · `/api/history` · `/api/time` | 船班/历史/服务器时间 |
| POST | `/api/routes/check` | 已审路线时间区间求交检查 |
| POST/GET | `/api/plans` · `/api/plans/<id>/reconnect` | 收藏快照与重连前后对比 |
| POST/GET | `/api/offline` · `/api/offline/<id>/status` | 离线包与失效判定(服务器时间) |
| GET | `/api/print/<plan_id>` | 打印页数据(有效期/未确定事项/声明) |

设计取舍详见 `docs/DESIGN.md`。
