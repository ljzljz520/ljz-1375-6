"""数据库层:SQLite。保存公告来源时间、适用日期、内容代次。"""
import sqlite3

SCHEMA = """
PRAGMA foreign_keys = ON;

-- 经确认的公告:来源、来源时间、内容代次;适用日期在 scope 表
CREATE TABLE IF NOT EXISTS announcement (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,            -- 来源(海事局/气象站/景区管理处...)
  source_time   TEXT NOT NULL,            -- 来源发布时间(核对时间基准)
  generation    INTEGER NOT NULL,         -- 内容代次(同一来源同一类单调递增)
  kind          TEXT NOT NULL,            -- ship / weather / tide / venue
  payload       TEXT NOT NULL,            -- JSON 原文
  payload_hash  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'confirmed',
  imported_at   TEXT NOT NULL,
  UNIQUE(source, kind, generation, payload_hash)   -- 幂等:完全重复的公告只入一次
);

CREATE TABLE IF NOT EXISTS announcement_scope (
  announcement_id INTEGER NOT NULL REFERENCES announcement(id) ON DELETE CASCADE,
  valid_from TEXT NOT NULL,               -- 适用日期/区间起
  valid_to   TEXT NOT NULL                -- 适用日期/区间止
);

-- 船班航段。notify_key 为航次幂等键;同键高代次取代低代次(临时取消即如此生效)
CREATE TABLE IF NOT EXISTS ship_segment (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  notify_key    TEXT NOT NULL,
  group_key     TEXT NOT NULL,            -- 取代分组 = notify_key
  route_code    TEXT NOT NULL,
  direction     TEXT NOT NULL CHECK(direction IN ('out','return')),
  depart_port   TEXT NOT NULL,
  arrive_port   TEXT NOT NULL,
  depart_at     TEXT NOT NULL,
  arrive_at     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK(status IN ('scheduled','cancelled')),
  source        TEXT NOT NULL,
  generation    INTEGER NOT NULL,
  announcement_id INTEGER NOT NULL REFERENCES announcement(id),
  last_verified_at TEXT NOT NULL,         -- 该条件最后核对时间(=来源时间)
  UNIQUE(notify_key, generation)
);

-- 潮汐窗口:start/end 可跨日(如 23:00 -> 次日 01:00)
CREATE TABLE IF NOT EXISTS tide_window (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  target_key    TEXT NOT NULL,            -- station|start|end (唯一键)
  group_key     TEXT NOT NULL,            -- station|date|tide (取代分组,全量替换)
  station       TEXT NOT NULL,
  start_at      TEXT NOT NULL,
  end_at        TEXT NOT NULL,
  status        TEXT NOT NULL CHECK(status IN ('ok','adverse')),
  level         TEXT,
  source        TEXT NOT NULL,
  generation    INTEGER NOT NULL,
  announcement_id INTEGER NOT NULL REFERENCES announcement(id),
  last_verified_at TEXT NOT NULL,
  UNIQUE(target_key, generation)
);

CREATE TABLE IF NOT EXISTS weather_window (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  target_key    TEXT NOT NULL,
  group_key     TEXT NOT NULL,            -- area|date|forecast
  area          TEXT NOT NULL,
  start_at      TEXT NOT NULL,
  end_at        TEXT NOT NULL,
  status        TEXT NOT NULL CHECK(status IN ('ok','adverse')),
  summary       TEXT,
  source        TEXT NOT NULL,
  generation    INTEGER NOT NULL,
  announcement_id INTEGER NOT NULL REFERENCES announcement(id),
  last_verified_at TEXT NOT NULL,
  UNIQUE(target_key, generation)
);

-- 场所开放(登岛码头/观景台等);open 与 closure 分属不同取代分组
CREATE TABLE IF NOT EXISTS venue_window (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  target_key    TEXT NOT NULL,
  group_key     TEXT NOT NULL,            -- venue|date|open 或 venue|date|closure|start|end
  venue         TEXT NOT NULL,
  start_at      TEXT NOT NULL,
  end_at        TEXT NOT NULL,
  status        TEXT NOT NULL CHECK(status IN ('open','closed')),
  source        TEXT NOT NULL,
  generation    INTEGER NOT NULL,
  announcement_id INTEGER NOT NULL REFERENCES announcement(id),
  last_verified_at TEXT NOT NULL,
  UNIQUE(target_key, generation)
);

-- 灯塔历史与守塔人资料:静态史料,临时取消等业务永不触碰
CREATE TABLE IF NOT EXISTS lighthouse (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, built_year INTEGER, history TEXT
);
CREATE TABLE IF NOT EXISTS keeper (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, tenure_from TEXT, tenure_to TEXT, story TEXT
);

-- 已审路线及其有序航段(ship 引用航段;visit 引用场所+计划时段)
CREATE TABLE IF NOT EXISTS route (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('approved','draft')) DEFAULT 'approved'
);
CREATE TABLE IF NOT EXISTS route_segment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id INTEGER NOT NULL REFERENCES route(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('ship','visit')),
  ref TEXT NOT NULL,                      -- ship: ship_segment.id ; visit: 场所名
  planned_start TEXT, planned_end TEXT,   -- visit 的计划时段(求交用)
  label TEXT
);

-- 收藏计划:保存收藏时刻的条件快照,供重连前后对比
CREATE TABLE IF NOT EXISTS plan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_name TEXT NOT NULL,
  route_id INTEGER NOT NULL REFERENCES route(id),
  target_date TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 后台预计算的当日计划(缓存);公告导入时按适用日期置 stale
CREATE TABLE IF NOT EXISTS daily_plan (
  date TEXT PRIMARY KEY,
  verdict TEXT NOT NULL,
  windows_json TEXT NOT NULL,
  conditions_json TEXT NOT NULL,
  generation INTEGER NOT NULL,
  computed_at TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0
);

-- 离线包:带过期时间与代次;过期或代次落后即失效,且永不构成现场保证
CREATE TABLE IF NOT EXISTS offline_package (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_name TEXT NOT NULL,
  target_date TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  generation INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);

-- 冲突记录:同代次不同来源互相矛盾时登记,相关条件按未知处理
CREATE TABLE IF NOT EXISTS conflict_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL, target_key TEXT NOT NULL,
  detail TEXT NOT NULL, created_at TEXT NOT NULL
);
"""

def connect(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

def init_db(conn):
    conn.executescript(SCHEMA)
    conn.commit()
