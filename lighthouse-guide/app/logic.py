"""核心领域逻辑。

原则:
- 船班/天气/潮汐/场所开放是四个独立条件,任一缺失或互相冲突时结论保留 UNKNOWN,
  绝不只看其中一项就给出可登岛结论。
- 一切"是否过期/最后核对"判断只使用服务器时间,客户端时钟不可信。
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone

ISLAND_TZ = timezone(timedelta(hours=8), name="灯塔岛时区")
UTC = timezone.utc

FAVORABLE, ADVERSE, UNKNOWN = "favorable", "adverse", "unknown"
LANDABLE, NOT_LANDABLE, V_UNKNOWN = "LANDABLE", "NOT_LANDABLE", "UNKNOWN"

CONDITION_LABELS = {"ship": "船班", "weather": "天气", "tide": "潮汐", "venue": "场所开放"}

DISCLAIMER = ("本资料(含离线包/打印页)仅为出行参考快照,不构成现场安全或交通保障承诺;"
              "请以现场公告、海事与景区工作人员指引为准。")


# ---------- 时间工具 ----------
def now_utc() -> datetime:
    return datetime.now(UTC)

def parse(s: str) -> datetime:
    dt = datetime.fromisoformat(s)
    return dt if dt.tzinfo else dt.replace(tzinfo=ISLAND_TZ)

def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat()

def day_bounds(date_str: str):
    d = datetime.fromisoformat(date_str).date()
    start = datetime(d.year, d.month, d.day, tzinfo=ISLAND_TZ)
    return start, start + timedelta(days=1)


# ---------- 区间运算 ----------
def overlap(a, b):
    s, e = max(a[0], b[0]), min(a[1], b[1])
    return (s, e) if s < e else None

def intersect_many(intervals):
    """多个区间列表求交:返回所有条件同时满足的片段。"""
    pieces = intervals[0][:]
    for lst in intervals[1:]:
        nxt = []
        for p in pieces:
            for q in lst:
                ov = overlap(p, q)
                if ov:
                    nxt.append(ov)
        pieces = nxt
    return pieces

def subtract(intervals, blocks):
    out = intervals[:]
    for b in blocks:
        nxt = []
        for s, e in out:
            if b[1] <= s or b[0] >= e:
                nxt.append((s, e))
            else:
                if s < b[0]:
                    nxt.append((s, b[0]))
                if b[1] < e:
                    nxt.append((b[1], e))
        out = nxt
    return out


# ---------- 公告导入 ----------
def payload_hash(payload) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

def _date_of(ts: str) -> str:
    return parse(ts).astimezone(ISLAND_TZ).date().isoformat()

def import_announcement(conn, ann: dict) -> dict:
    """导入一条经确认的公告。拒绝未确认公告;完全重复的公告幂等去重。"""
    if ann.get("status", "confirmed") != "confirmed":
        raise ValueError("只接受经确认的公告(status=confirmed)")
    kind, gen = ann["kind"], int(ann["generation"])
    source, source_time = ann["source"], ann["source_time"]
    payload = ann["payload"]
    ph = payload_hash(payload)
    cur = conn.execute(
        "INSERT OR IGNORE INTO announcement(source,source_time,generation,kind,payload,payload_hash,status,imported_at)"
        " VALUES(?,?,?,?,?,?,?,?)",
        (source, source_time, gen, kind, json.dumps(payload, ensure_ascii=False), ph, "confirmed", iso(now_utc())))
    if cur.rowcount == 0:
        return {"imported": False, "duplicate": True, "reason": "相同来源/代次/内容的公告已存在,幂等忽略"}
    ann_id = cur.lastrowid
    for sc in ann.get("scope", []):
        conn.execute("INSERT INTO announcement_scope(announcement_id,valid_from,valid_to) VALUES(?,?,?)",
                     (ann_id, sc["valid_from"], sc["valid_to"]))
    summary = {"imported": True, "duplicate": False, "announcement_id": ann_id,
               "items": 0, "superseded": 0, "duplicates": 0, "conflicts": 0}

    # 各表:键列名 + 数据列名(值与列名严格分离)
    TABLE_SPEC = {
        "ship_segment": ("notify_key",
                         ["route_code", "direction", "depart_port", "arrive_port",
                          "depart_at", "arrive_at", "status"]),
        "tide_window": ("target_key", ["station", "start_at", "end_at", "status", "level"]),
        "weather_window": ("target_key", ["area", "start_at", "end_at", "status", "summary"]),
        "venue_window": ("target_key", ["venue", "start_at", "end_at", "status"]),
    }

    def put(table, key, group_key, values, status):
        """同组低代次行被取代(删除);同键同代次为重复通知,幂等忽略。"""
        key_col, data_cols = TABLE_SPEC[table]
        old = conn.execute(f"DELETE FROM {table} WHERE group_key=? AND generation<?",
                           (group_key, gen)).rowcount
        summary["superseded"] += old
        cols = [key_col, "group_key", *data_cols, "source", "generation",
                "announcement_id", "last_verified_at"]
        vals = [key, group_key, *values, source, gen, ann_id, iso(parse(source_time))]
        sql = f"INSERT OR IGNORE INTO {table}({','.join(cols)}) VALUES({','.join('?' * len(cols))})"
        cur2 = conn.execute(sql, vals)
        if cur2.rowcount == 0:
            summary["duplicates"] += 1
            existing = conn.execute(
                f"SELECT status FROM {table} WHERE {key_col}=? AND generation=?",
                (key, gen)).fetchone()
            if existing and existing["status"] != status:
                conn.execute("INSERT INTO conflict_log(kind,target_key,detail,created_at) VALUES(?,?,?,?)",
                             (kind, key,
                              f"来源 {source} 与既有记录在同代次({gen})下状态矛盾:"
                              f"{existing['status']} vs {status}", iso(now_utc())))
                summary["conflicts"] += 1
        else:
            summary["items"] += 1

    for it in payload.get("items", []):
        # 所有时间统一归一化为 UTC 存储,保证字符串比较与区间运算一致
        if kind == "ship":
            key = it["notify_key"]
            put("ship_segment", key, key,
                [it["route_code"], it["direction"], it["depart_port"], it["arrive_port"],
                 iso(parse(it["depart_at"])), iso(parse(it["arrive_at"])), it["status"]], it["status"])
        elif kind == "tide":
            s, e = iso(parse(it["start_at"])), iso(parse(it["end_at"]))
            tk = f"{it['station']}|{s}|{e}"
            gk = f"{it['station']}|{_date_of(it['start_at'])}|tide"
            put("tide_window", tk, gk,
                [it["station"], s, e, it["status"], it.get("level", "")], it["status"])
        elif kind == "weather":
            s, e = iso(parse(it["start_at"])), iso(parse(it["end_at"]))
            tk = f"{it['area']}|{s}|{e}"
            gk = f"{it['area']}|{_date_of(it['start_at'])}|forecast"
            put("weather_window", tk, gk,
                [it["area"], s, e, it["status"], it.get("summary", "")], it["status"])
        elif kind == "venue":
            s, e = iso(parse(it["start_at"])), iso(parse(it["end_at"]))
            sub = "open" if it["status"] == "open" else f"closure|{s}|{e}"
            tk = f"{it['venue']}|{s}|{e}|{it['status']}"
            gk = f"{it['venue']}|{_date_of(it['start_at'])}|{sub}"
            put("venue_window", tk, gk,
                [it["venue"], s, e, it["status"]], it["status"])
        else:
            raise ValueError(f"未知公告类型: {kind}")

    # 按适用日期使预计算缓存失效
    dates = set()
    for sc in ann.get("scope", []):
        d0, d1 = parse(sc["valid_from"]), parse(sc["valid_to"])
        while d0 <= d1:
            dates.add(d0.astimezone(ISLAND_TZ).date().isoformat())
            d0 += timedelta(days=1)
    for it in payload.get("items", []):
        ts = it.get("start_at") or it.get("depart_at")
        if ts:
            dates.add(_date_of(ts))
            dates.add((parse(ts) + timedelta(days=1)).astimezone(ISLAND_TZ).date().isoformat())
    for d in dates:
        conn.execute("UPDATE daily_plan SET stale=1 WHERE date=?", (d,))
    summary["invalidated_dates"] = sorted(dates)
    conn.commit()
    return summary


# ---------- 条件求值 ----------
def _active_rows(rows):
    """每个取代分组只保留最高代次。"""
    best = {}
    for r in rows:
        g = r["group_key"]
        if g not in best or r["generation"] > best[g]["generation"]:
            best[g] = r
    return list(best.values())

def _window_conflicts(rows):
    """同代次、不同来源、时间重叠且状态矛盾 -> 冲突(保留未知)。"""
    out = []
    rows = list(rows)
    for i in range(len(rows)):
        for j in range(i + 1, len(rows)):
            a, b = rows[i], rows[j]
            if a["source"] != b["source"] and a["status"] != b["status"]:
                ov = overlap((parse(a["start_at"]), parse(a["end_at"])),
                             (parse(b["start_at"]), parse(b["end_at"])))
                if ov:
                    out.append({"sources": [a["source"], b["source"]],
                                "span": [iso(ov[0]), iso(ov[1])]})
    return out

def _logged_conflicts(conn, kind, keys):
    keys = list(keys)
    if not keys:
        return []
    q = f"SELECT * FROM conflict_log WHERE kind=? AND target_key IN ({','.join('?' * len(keys))})"
    return [dict(c) for c in conn.execute(q, (kind, *keys)).fetchall()]

def _eval_windows(conn, rows, kind, label, ok_status, bad_status):
    if not rows:
        return {"status": UNKNOWN, "no_data": True, "ok": [], "bad": [], "conflicts": [],
                "reasons": [f"缺少{label}公告数据"], "last_verified_at": None, "generation": None}
    act = _active_rows(rows)
    # 冲突来源一:现存有效行之间互相矛盾;来源二:导入时登记的同键同代次矛盾
    conflicts = (_window_conflicts(act)
                 + _logged_conflicts(conn, kind, {r["target_key"] for r in act}))
    ok = [(parse(r["start_at"]), parse(r["end_at"])) for r in act if r["status"] in ok_status]
    bad = [(parse(r["start_at"]), parse(r["end_at"])) for r in act if r["status"] in bad_status]
    reasons = []
    if conflicts:
        ok, bad = [], []          # 互相冲突:该条件整体保留未知
        reasons.append(f"{label}公告互相冲突,按未知处理")
    status = UNKNOWN if conflicts else (FAVORABLE if ok else (ADVERSE if bad else UNKNOWN))
    return {"status": status, "no_data": False, "ok": ok, "bad": bad, "conflicts": conflicts,
            "reasons": reasons,
            "last_verified_at": max(r["last_verified_at"] for r in act),
            "generation": max(r["generation"] for r in act)}

def _eval_ships(conn, rows):
    if not rows:
        return {"status": UNKNOWN, "no_data": True, "stays": [], "cancelled": [], "conflicts": [],
                "reasons": ["缺少船班公告数据"], "last_verified_at": None, "generation": None}
    act = _active_rows(rows)
    conf = _logged_conflicts(conn, "ship", {r["notify_key"] for r in act})
    cancelled = [r for r in act if r["status"] == "cancelled"]
    scheduled = [r for r in act if r["status"] == "scheduled"]
    outs = [r for r in scheduled if r["direction"] == "out"]
    rets = sorted([r for r in scheduled if r["direction"] == "return"], key=lambda r: r["depart_at"])
    stays, reasons = [], []
    for o in outs:
        arr = parse(o["arrive_at"])
        nxt = [r for r in rets if parse(r["depart_at"]) > arr]
        if nxt:
            stays.append((arr, parse(nxt[0]["depart_at"])))
        else:
            reasons.append(f"航次 {o['route_code']} 缺少可衔接返程船班")
    for c in cancelled:
        reasons.append(f"航次 {c['route_code']}({c['depart_at']})已临时取消")
    if conf:
        reasons.append("船班公告存在同代次冲突,按未知处理")
    status = UNKNOWN if conf else (FAVORABLE if stays else (ADVERSE if (cancelled or scheduled) else UNKNOWN))
    return {"status": status, "no_data": False, "stays": stays, "cancelled": cancelled,
            "conflicts": conf, "reasons": reasons,
            "last_verified_at": max(r["last_verified_at"] for r in act),
            "generation": max(r["generation"] for r in act)}


# ---------- 登岛窗口组合 ----------
def compute_landing(conn, date_str: str) -> dict:
    ds, de = day_bounds(date_str)
    pad = timedelta(hours=6)
    ships = conn.execute(
        "SELECT * FROM ship_segment WHERE depart_at < ? AND arrive_at > ?",
        (iso(de + pad), iso(ds - pad))).fetchall()
    weather = conn.execute(
        "SELECT * FROM weather_window WHERE start_at < ? AND end_at > ?", (iso(de), iso(ds))).fetchall()
    tide = conn.execute(
        "SELECT * FROM tide_window WHERE start_at < ? AND end_at > ?", (iso(de), iso(ds))).fetchall()
    venue = conn.execute(
        "SELECT * FROM venue_window WHERE start_at < ? AND end_at > ?", (iso(de), iso(ds))).fetchall()

    conds = {
        "ship": _eval_ships(conn, ships),
        "weather": _eval_windows(conn, weather, "weather", "天气", ("ok",), ("adverse",)),
        "tide": _eval_windows(conn, tide, "tide", "潮汐", ("ok",), ("adverse",)),
        "venue": _eval_windows(conn, venue, "venue", "场所开放", ("open",), ("closed",)),
    }
    windows, reasons, undetermined = [], [], []
    for k, c in conds.items():
        reasons.extend(c["reasons"])
        if c["status"] == UNKNOWN:
            undetermined.append(f"{CONDITION_LABELS[k]}: " + (";".join(c["reasons"]) or "数据不足"))

    if conds["ship"]["status"] != UNKNOWN:
        ok_lists = [conds[k]["ok"] for k in ("weather", "tide", "venue")]
        bad_all = [iv for k in ("weather", "tide", "venue") for iv in conds[k]["bad"]]
        for stay in conds["ship"]["stays"]:
            pieces = intersect_many([[stay]] + ok_lists) if all(ok_lists) else []
            pieces = subtract(pieces, bad_all)
            windows.extend(pieces)
    windows = sorted({(s, e) for s, e in windows})

    if windows:
        verdict = LANDABLE
    elif conds["ship"]["status"] == ADVERSE:
        verdict = NOT_LANDABLE
        reasons.append("无可用水上航段(船班取消或不衔接)")
    elif any(c["status"] == UNKNOWN for c in conds.values()):
        verdict = V_UNKNOWN          # 数据不足/冲突:保留未知
    else:
        verdict = NOT_LANDABLE       # 四项都有数据但无共同有利窗口
        reasons.append("四项条件无共同有利时间窗口")

    gen = max([c["generation"] or 0 for c in conds.values()] or [0])
    return {
        "date": date_str, "verdict": verdict,
        "windows": [{"start": iso(s), "end": iso(e)} for s, e in windows],
        "conditions": {k: _public_condition(c) for k, c in conds.items()},
        "reasons": reasons, "undetermined": undetermined,
        "generation": gen, "server_time": iso(now_utc()), "disclaimer": DISCLAIMER,
    }

def _public_condition(c):
    out = {"status": c["status"], "reasons": c["reasons"],
           "last_verified_at": c["last_verified_at"], "generation": c["generation"]}
    for key in ("ok", "bad", "stays"):
        if key in c:
            out[key] = [{"start": iso(s), "end": iso(e)} for s, e in c[key]]
    if "cancelled" in c:
        out["cancelled"] = [{"route_code": r["route_code"], "depart_at": r["depart_at"],
                             "notify_key": r["notify_key"]} for r in c["cancelled"]]
    if c.get("conflicts"):
        out["conflicts"] = c["conflicts"]
    return out


# ---------- 已审路线:时间区间求交检查 ----------
def check_route(conn, route_id: int, date_str: str) -> dict:
    route = conn.execute("SELECT * FROM route WHERE id=?", (route_id,)).fetchone()
    if not route:
        raise KeyError("路线不存在")
    segs = conn.execute("SELECT * FROM route_segment WHERE route_id=? ORDER BY seq", (route_id,)).fetchall()
    results = []
    for seg in segs:
        item = {"seq": seg["seq"], "kind": seg["kind"], "label": seg["label"], "status": "ok", "detail": ""}
        if seg["kind"] == "ship":
            # 路线引用航次键(notify_key):高代次公告取代旧行后引用依然有效
            rows = conn.execute("SELECT * FROM ship_segment WHERE notify_key=?",
                                (seg["ref"],)).fetchall()
            if not rows:
                item.update(status="unknown", detail="航段无公告数据")
            else:
                act = _active_rows(rows)[0]
                if act["status"] == "cancelled":
                    item.update(status="broken",
                                detail=f"航段 {act['route_code']} 已临时取消(代次{act['generation']})")
                else:
                    item["detail"] = f"{act['route_code']} {act['depart_at']}→{act['arrive_at']} 正常"
                    item["window"] = {"start": act["depart_at"], "end": act["arrive_at"]}
        else:  # visit:计划时段与场所开放/关闭区间求交
            ps, pe = parse(seg["planned_start"]), parse(seg["planned_end"])
            wins = conn.execute(
                "SELECT * FROM venue_window WHERE venue=? AND start_at < ? AND end_at > ?",
                (seg["ref"], iso(pe), iso(ps))).fetchall()
            act = _active_rows(wins)
            closed = [w for w in act if w["status"] == "closed"
                      and overlap((ps, pe), (parse(w["start_at"]), parse(w["end_at"])))]
            opened = [w for w in act if w["status"] == "open"]
            # 覆盖判定:计划时段被开放区间并集完全覆盖(求交/差集)
            open_ivs = [(parse(w["start_at"]), parse(w["end_at"])) for w in opened]
            covered = bool(open_ivs) and not subtract([(ps, pe)], open_ivs)
            if closed:
                item.update(status="broken",
                            detail=f"场所「{seg['ref']}」在计划时段内临时关闭")
            elif not act:
                item.update(status="unknown", detail=f"场所「{seg['ref']}」无开放公告")
            elif not covered:
                item.update(status="unknown", detail=f"场所「{seg['ref']}」开放时段未覆盖计划时段")
            else:
                item["detail"] = f"场所「{seg['ref']}」开放,计划时段在开放区间内"
        results.append(item)
    broken = [r for r in results if r["status"] == "broken"]
    unknown = [r for r in results if r["status"] == "unknown"]
    feasible = not broken and not unknown
    return {"route_id": route_id, "route_name": route["name"], "date": date_str,
            "feasible": feasible, "segments": results,
            "affected": [r for r in results if r["status"] != "ok"],
            "note": "历史守塔人资料为静态史料,不随航段取消失效",
            "server_time": iso(now_utc())}


# ---------- 收藏计划快照与重连对比 ----------
def take_snapshot(conn, route_id: int, date_str: str) -> dict:
    return {"landing": compute_landing(conn, date_str),
            "route_check": check_route(conn, route_id, date_str),
            "taken_at": iso(now_utc())}

def diff_snapshots(before: dict, after: dict) -> list:
    changes = []
    bl, al = before["landing"], after["landing"]
    if bl["verdict"] != al["verdict"]:
        changes.append({"what": "登岛结论", "before": bl["verdict"], "after": al["verdict"]})
    for k in CONDITION_LABELS:
        b, a = bl["conditions"][k], al["conditions"][k]
        if b["status"] != a["status"]:
            changes.append({"what": f"{CONDITION_LABELS[k]}状态",
                            "before": b["status"], "after": a["status"]})
        if b["generation"] != a["generation"]:
            changes.append({"what": f"{CONDITION_LABELS[k]}内容代次",
                            "before": b["generation"], "after": a["generation"]})
    bs = {s["seq"]: s["status"] for s in before["route_check"]["segments"]}
    as_ = {s["seq"]: s["status"] for s in after["route_check"]["segments"]}
    for seq in sorted(bs):
        if bs[seq] != as_.get(seq):
            changes.append({"what": f"路线航段#{seq}", "before": bs[seq], "after": as_.get(seq)})
    return changes


# ---------- 预计算(后台) ----------
def recompute_daily_plan(conn, date_str: str) -> dict:
    res = compute_landing(conn, date_str)
    conn.execute(
        "INSERT INTO daily_plan(date,verdict,windows_json,conditions_json,generation,computed_at,stale)"
        " VALUES(?,?,?,?,?,?,0)"
        " ON CONFLICT(date) DO UPDATE SET verdict=excluded.verdict,windows_json=excluded.windows_json,"
        " conditions_json=excluded.conditions_json,generation=excluded.generation,"
        " computed_at=excluded.computed_at,stale=0",
        (date_str, res["verdict"], json.dumps(res["windows"]), json.dumps(res["conditions"]),
         res["generation"], iso(now_utc())))
    conn.commit()
    return res

def read_precomputed(conn, date_str: str):
    row = conn.execute("SELECT * FROM daily_plan WHERE date=?", (date_str,)).fetchone()
    if not row:
        return None
    return {"date": date_str, "verdict": row["verdict"], "windows": json.loads(row["windows_json"]),
            "conditions": json.loads(row["conditions_json"]), "generation": row["generation"],
            "computed_at": row["computed_at"], "stale": bool(row["stale"])}


# ---------- 离线包 ----------
def current_max_generation(conn, date_str: str) -> int:
    return compute_landing(conn, date_str)["generation"]

def make_offline_package(conn, user: str, date_str: str, ttl_hours: int = 12) -> dict:
    landing = compute_landing(conn, date_str)
    now = now_utc()
    payload = {"date": date_str, "landing": landing, "undetermined": landing["undetermined"],
               "generated_at": iso(now), "expires_at": iso(now + timedelta(hours=ttl_hours)),
               "disclaimer": DISCLAIMER,
               "validity_note": "本包内各条件以其 last_verified_at 为最后核对时间;过期或公告代次更新后即失效。"}
    cur = conn.execute(
        "INSERT INTO offline_package(user_name,target_date,generated_at,expires_at,generation,payload_json)"
        " VALUES(?,?,?,?,?,?)",
        (user, date_str, iso(now), payload["expires_at"], landing["generation"],
         json.dumps(payload, ensure_ascii=False)))
    conn.commit()
    return {"id": cur.lastrowid, **payload}

def offline_status(conn, pkg_id: int, client_clock: str | None = None) -> dict:
    """过期/失效判断只认服务器时间;客户端时钟仅记录偏差。"""
    pkg = conn.execute("SELECT * FROM offline_package WHERE id=?", (pkg_id,)).fetchone()
    if not pkg:
        raise KeyError("离线包不存在")
    server_now = now_utc()
    expired = server_now > parse(pkg["expires_at"])
    gen_now = current_max_generation(conn, pkg["target_date"])
    stale_generation = gen_now > pkg["generation"]
    skew = None
    if client_clock:
        try:
            skew = (parse(client_clock) - server_now).total_seconds()
        except ValueError:
            skew = None
    stale = expired or stale_generation
    return {"id": pkg_id, "stale": stale, "expired": expired, "stale_generation": stale_generation,
            "generation": pkg["generation"], "current_generation": gen_now,
            "expires_at": pkg["expires_at"], "server_time": iso(server_now),
            "client_clock": client_clock, "clock_skew_seconds": skew,
            "usable_as_reference_only": True,
            "warning": ("离线包已失效,不得作为现场安全或交通保证" if stale
                        else "离线包在有效期内,但仍仅为参考,不构成现场保证"),
            "disclaimer": DISCLAIMER}
