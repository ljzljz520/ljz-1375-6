"""验收测试:
1. 重复船班通知(幂等)      2. 跨日潮汐记录      3. 观景点临时关闭
4. 客户端时钟不准            5. 离线过期
另:四条件缺一不给可登岛结论、公告冲突保留未知、临时取消影响相关航段且守塔人资料不失效、
   预计算 vs 实时对比与缓存失效。
"""
import json
import sys
from datetime import timedelta

import pytest

sys.path.insert(0, "/workspace/lighthouse-guide")
from app import logic
from app.api import create_app
from app.db import connect, init_db
from app.seed import seed

D = "2026-10-08"


@pytest.fixture()
def env(tmp_path):
    db = str(tmp_path / "t.db")
    seed(db)
    app = create_app(db)
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c, db


def post_ann(client, ann):
    return client.post("/api/admin/announcements", data=json.dumps(ann),
                       content_type="application/json")


def ship_ann(gen, key="FERRY-1008-OUT1", status="cancelled", source="海事局客运调度",
             source_time="2026-10-07T08:00:00+08:00"):
    return {"source": source, "source_time": source_time, "generation": gen, "kind": "ship",
            "scope": [{"valid_from": D, "valid_to": D}],
            "payload": {"items": [
                {"notify_key": key, "route_code": "HD-101", "direction": "out",
                 "depart_port": "石浦港", "arrive_port": "灯塔岛码头",
                 "depart_at": f"{D}T08:30:00+08:00", "arrive_at": f"{D}T09:15:00+08:00",
                 "status": status}]}}


# ---------- 1. 重复船班通知 ----------
def test_duplicate_ship_notification_idempotent(env):
    client, db = env
    ann = ship_ann(gen=2)
    r1 = post_ann(client, ann)
    assert r1.status_code == 200 and r1.get_json()["imported"]
    n1 = connect(db).execute("SELECT COUNT(*) c FROM ship_segment").fetchone()["c"]
    # 完全相同内容再次推送 -> 幂等忽略,不产生新行
    r2 = post_ann(client, ann)
    j2 = r2.get_json()
    assert j2["duplicate"] is True and j2["imported"] is False
    n2 = connect(db).execute("SELECT COUNT(*) c FROM ship_segment").fetchone()["c"]
    assert n1 == n2
    # 同一航次更低代次重复推送 -> 不生效(当前已是 gen2 cancelled)
    old = ship_ann(gen=1, status="scheduled", source_time="2026-10-06T09:00:00+08:00")
    r3 = post_ann(client, old)
    assert r3.get_json()["superseded"] == 0
    row = connect(db).execute(
        "SELECT status,generation FROM ship_segment WHERE notify_key='FERRY-1008-OUT1'"
        " ORDER BY generation DESC LIMIT 1").fetchone()
    assert row["status"] == "cancelled" and row["generation"] == 2


def test_cancellation_affects_route_but_not_keeper_history(env):
    client, db = env
    before = client.get("/api/routes/check", query_string={}).status_code  # 405/方法不允许无所谓
    chk = client.post("/api/routes/check", data=json.dumps({"route_id": 1, "date": D}),
                      content_type="application/json").get_json()
    assert chk["feasible"] is True
    hist_before = client.get("/api/history").get_json()
    # 临时取消 HD-101
    post_ann(client, ship_ann(gen=2))
    chk2 = client.post("/api/routes/check", data=json.dumps({"route_id": 1, "date": D}),
                       content_type="application/json").get_json()
    assert chk2["feasible"] is False
    seg1 = [s for s in chk2["segments"] if s["seq"] == 1][0]
    assert seg1["status"] == "broken" and "临时取消" in seg1["detail"]
    # 登岛结论:HD-101 取消后仍有 HD-103/HD-104 可用 -> 不因此判 UNKNOWN
    landing = client.get("/api/landing", query_string={"date": D}).get_json()
    assert landing["verdict"] in ("LANDABLE", "NOT_LANDABLE")
    assert any("HD-101" in r for r in landing["conditions"]["ship"]["reasons"])
    # 守塔人资料不随取消失效
    hist_after = client.get("/api/history").get_json()
    assert hist_before["keepers"] == hist_after["keepers"]
    assert len(hist_after["keepers"]) == 3


# ---------- 2. 跨日潮汐记录 ----------
def test_cross_day_tide_window(env):
    client, db = env
    D2 = "2026-10-09"
    anns = [
        {"source": "海事局客运调度", "source_time": "2026-10-07T09:00:00+08:00", "generation": 3,
         "kind": "ship", "scope": [{"valid_from": D2, "valid_to": D2}],
         "payload": {"items": [
             {"notify_key": "FERRY-1009-OUT", "route_code": "HD-201", "direction": "out",
              "depart_port": "石浦港", "arrive_port": "灯塔岛码头",
              "depart_at": "2026-10-08T22:50:00+08:00", "arrive_at": "2026-10-08T23:35:00+08:00",
              "status": "scheduled"},
             {"notify_key": "FERRY-1009-RET", "route_code": "HD-202", "direction": "return",
              "depart_port": "灯塔岛码头", "arrive_port": "石浦港",
              "depart_at": "2026-10-09T05:40:00+08:00", "arrive_at": "2026-10-09T06:25:00+08:00",
              "status": "scheduled"}]}},
        {"source": "县气象站", "source_time": "2026-10-07T10:00:00+08:00", "generation": 2,
         "kind": "weather", "scope": [{"valid_from": D2, "valid_to": D2}],
         "payload": {"items": [
             {"area": "灯塔岛海域", "start_at": "2026-10-08T20:00:00+08:00",
              "end_at": "2026-10-09T08:00:00+08:00", "status": "ok", "summary": "晴"}]}},
        # 跨日潮汐:10-08 23:00 -> 10-09 01:00
        {"source": "海洋预报台", "source_time": "2026-10-07T11:00:00+08:00", "generation": 2,
         "kind": "tide", "scope": [{"valid_from": D2, "valid_to": D2}],
         "payload": {"items": [
             {"station": "灯塔岛验潮站", "start_at": "2026-10-08T23:00:00+08:00",
              "end_at": "2026-10-09T01:00:00+08:00", "status": "ok", "level": "跨日平潮"}]}},
        {"source": "景区管理处", "source_time": "2026-10-07T12:00:00+08:00", "generation": 2,
         "kind": "venue", "scope": [{"valid_from": D2, "valid_to": D2}],
         "payload": {"items": [
             {"venue": "登岛码头", "start_at": "2026-10-08T20:00:00+08:00",
              "end_at": "2026-10-09T12:00:00+08:00", "status": "open"}]}},
    ]
    for a in anns:
        assert post_ann(client, a).get_json()["imported"]
    res = client.get("/api/landing", query_string={"date": D2}).get_json()
    assert res["verdict"] == "LANDABLE"
    # 停留 23:35 -> 次日05:40;与潮汐 23:00->01:00 求交 -> 窗口 23:35 -> 01:00(跨日)
    w = res["windows"][0]
    assert w["start"].endswith("15:35:00+00:00")          # 23:35 +08
    assert w["end"].endswith("17:00:00+00:00")            # 次日 01:00 +08
    assert logic.parse(w["end"]) > logic.parse(w["start"])
    assert logic.parse(w["end"]).astimezone(logic.ISLAND_TZ).day == 9


# ---------- 3. 观景点临时关闭 ----------
def test_viewpoint_temporary_closure(env):
    client, db = env
    closure = {"source": "景区管理处", "source_time": "2026-10-07T15:00:00+08:00", "generation": 2,
               "kind": "venue", "scope": [{"valid_from": D, "valid_to": D}],
               "payload": {"items": [
                   {"venue": "灯塔观景台", "start_at": f"{D}T09:00:00+08:00",
                    "end_at": f"{D}T12:00:00+08:00", "status": "closed"}]}}
    assert post_ann(client, closure).get_json()["imported"]
    chk = client.post("/api/routes/check", data=json.dumps({"route_id": 1, "date": D}),
                      content_type="application/json").get_json()
    seg2 = [s for s in chk["segments"] if s["seq"] == 2][0]
    assert seg2["status"] == "broken" and "临时关闭" in seg2["detail"]
    assert chk["feasible"] is False
    # 关闭 09:00-12:00 落在上午停留窗内 -> 上午窗口被削去;登岛码头仍开放
    landing = client.get("/api/landing", query_string={"date": D}).get_json()
    venue = landing["conditions"]["venue"]
    assert venue["bad"] and venue["ok"]  # 同时存在开放与临时关闭区间
    # 守塔人资料不受影响
    assert len(client.get("/api/history").get_json()["keepers"]) == 3


# ---------- 4. 客户端时钟不准 ----------
def test_client_clock_skew_ignored(env):
    client, db = env
    pkg = client.post("/api/offline", data=json.dumps({"user": "u1", "date": D, "ttl_hours": 12}),
                      content_type="application/json").get_json()
    # 客户端时钟快 3 天:若信客户端则包必过期;服务器只用自己的时间
    future = (logic.now_utc() + timedelta(days=3)).isoformat()
    st = client.get(f"/api/offline/{pkg['id']}/status",
                    headers={"X-Client-Clock": future}).get_json()
    assert st["clock_skew_seconds"] > 3 * 24 * 3600 - 60
    assert st["expired"] is False and st["stale"] is False
    # 客户端时钟拨慢 3 天也不能让"未来才过期"的判断改变(服务器时间为准)
    past = (logic.now_utc() - timedelta(days=3)).isoformat()
    st2 = client.get(f"/api/offline/{pkg['id']}/status",
                     headers={"X-Client-Clock": past}).get_json()
    assert st2["expired"] is False
    t = client.get("/api/time", headers={"X-Client-Clock": past}).get_json()
    assert t["clock_skew_seconds"] < -3 * 24 * 3600 + 60


# ---------- 5. 离线过期 ----------
def test_offline_expiry_by_time_and_generation(env):
    client, db = env
    # 时间过期:ttl=0 立即过期
    pkg0 = client.post("/api/offline", data=json.dumps({"user": "u2", "date": D, "ttl_hours": 0}),
                       content_type="application/json").get_json()
    st = client.get(f"/api/offline/{pkg0['id']}/status").get_json()
    assert st["expired"] is True and st["stale"] is True
    assert "不得作为现场安全或交通保证" in st["warning"]
    # 代次过期:生成后导入新代次公告 -> stale_generation
    pkg1 = client.post("/api/offline", data=json.dumps({"user": "u2", "date": D, "ttl_hours": 12}),
                       content_type="application/json").get_json()
    st1 = client.get(f"/api/offline/{pkg1['id']}/status").get_json()
    assert st1["stale"] is False
    post_ann(client, ship_ann(gen=2))  # 新代次取消公告
    st2 = client.get(f"/api/offline/{pkg1['id']}/status").get_json()
    assert st2["stale_generation"] is True and st2["stale"] is True
    # 包体自带免责声明与未确定事项字段
    assert "不构成现场安全或交通保障承诺" in pkg1["disclaimer"]
    assert "undetermined" in pkg1 and "validity_note" in pkg1


# ---------- 组合规则 ----------
def test_single_condition_never_concludes_landable(env):
    client, db = env
    conn = connect(db)
    # 清空天气/潮汐/场所,只留船班 -> 必须 UNKNOWN,不能只看船班
    for t in ("weather_window", "tide_window", "venue_window"):
        conn.execute(f"DELETE FROM {t}")
    conn.commit(); conn.close()
    res = client.get("/api/landing", query_string={"date": D}).get_json()
    assert res["verdict"] == "UNKNOWN"
    assert len(res["undetermined"]) == 3
    # 只剩天气一项有利,其余缺失 -> 仍 UNKNOWN
    conn = connect(db)
    conn.execute("DELETE FROM ship_segment")
    conn.execute("INSERT INTO weather_window(target_key,group_key,area,start_at,end_at,status,summary,"
                 "source,generation,announcement_id,last_verified_at) VALUES('w|x','w|g','灯塔岛海域',"
                 f"'{D}T06:00:00+08:00','{D}T20:00:00+08:00','ok','晴','县气象站',9,1,'2026-10-07T00:00:00+08:00')")
    conn.commit(); conn.close()
    res2 = client.get("/api/landing", query_string={"date": D}).get_json()
    assert res2["verdict"] == "UNKNOWN"


def test_conflicting_announcements_keep_unknown(env):
    client, db = env
    # 另一来源同代次给出矛盾天气(同一时段 adverse)
    conflict = {"source": "邻县气象站", "source_time": "2026-10-06T10:30:00+08:00", "generation": 1,
                "kind": "weather", "scope": [{"valid_from": D, "valid_to": D}],
                "payload": {"items": [
                    {"area": "灯塔岛海域", "start_at": f"{D}T06:00:00+08:00",
                     "end_at": f"{D}T20:00:00+08:00", "status": "adverse",
                     "summary": "大风 8 级(与县气象站矛盾)"}]}}
    post_ann(client, conflict)
    res = client.get("/api/landing", query_string={"date": D}).get_json()
    assert res["conditions"]["weather"]["status"] == "unknown"
    assert res["verdict"] == "UNKNOWN"
    assert any("天气" in u for u in res["undetermined"])


def test_precompute_compare_and_invalidation(env):
    client, db = env
    r = client.get("/api/landing", query_string={"date": D, "mode": "compare"}).get_json()
    assert r["precomputed"] and r["precomputed"]["stale"] is False
    assert r["consistent"] is True
    assert r["latency_ms"]["precomputed_read"] >= 0
    # 导入新公告 -> 预计算缓存按适用日期失效
    post_ann(client, ship_ann(gen=2))
    pre = client.get("/api/landing", query_string={"date": D, "mode": "precomputed"}).get_json()
    assert pre["stale"] is True
    r2 = client.get("/api/landing", query_string={"date": D, "mode": "compare"}).get_json()
    assert r2["consistent"] is False
    # 重新预计算后恢复一致
    client.post("/api/admin/precompute", data=json.dumps({"date": D}),
                content_type="application/json")
    r3 = client.get("/api/landing", query_string={"date": D, "mode": "compare"}).get_json()
    assert r3["consistent"] is True


def test_plan_reconnect_shows_before_after(env):
    client, db = env
    plan = client.post("/api/plans", data=json.dumps({"user": "u3", "route_id": 1, "date": D}),
                       content_type="application/json").get_json()
    # 收藏后发生变化:取消 HD-101 + 关闭观景台
    post_ann(client, ship_ann(gen=2))
    post_ann(client, {"source": "景区管理处", "source_time": "2026-10-07T16:00:00+08:00",
                      "generation": 2, "kind": "venue",
                      "scope": [{"valid_from": D, "valid_to": D}],
                      "payload": {"items": [
                          {"venue": "灯塔观景台", "start_at": f"{D}T09:00:00+08:00",
                           "end_at": f"{D}T12:00:00+08:00", "status": "closed"}]}})
    rec = client.get(f"/api/plans/{plan['id']}/reconnect").get_json()
    assert rec["before"]["route_check"]["feasible"] is True
    assert rec["after"]["route_check"]["feasible"] is False
    whats = {c["what"] for c in rec["changes"]}
    assert "路线航段#1" in whats and "路线航段#2" in whats
    assert any(c["what"] == "船班内容代次" for c in rec["changes"])
    # 打印页数据:有效期 + 未确定事项 + 免责声明
    pd = client.get(f"/api/print/{plan['id']}").get_json()
    assert len(pd["validity"]) == 4
    assert all(v["last_verified_at"] for v in pd["validity"])
    assert "undetermined" in pd and "不构成现场安全或交通保障承诺" in pd["disclaimer"]
    assert "旧离线包" in pd["offline_note"]


def test_unconfirmed_announcement_rejected(env):
    client, db = env
    ann = ship_ann(gen=5)
    ann["status"] = "draft"
    r = post_ann(client, ann)
    assert r.status_code == 400
