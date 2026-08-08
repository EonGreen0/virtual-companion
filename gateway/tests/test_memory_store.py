"""MemoryStore 单元测试（不依赖 Ollama / 网络）。"""

import math
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memory_store import MemoryStore


def vec(cos: float, dim: int = 8) -> list[float]:
    """构造与基准向量 [1,0,0...] 余弦相似度为 cos 的向量。"""
    v = [0.0] * dim
    v[0] = cos
    v[1] = math.sqrt(max(0.0, 1.0 - cos * cos))
    return v


def make_store(tmp_path) -> MemoryStore:
    return MemoryStore(str(tmp_path / "test.db"), "http://localhost:11434", "bge-m3")


def test_scope_isolation(tmp_path):
    s = make_store(tmp_path)
    s.add("fact", "用户喜欢西瓜", vec(1.0), 6.0, user_id="u1", agent_id="a1")
    s.add("fact", "另一个角色的秘密", vec(1.0), 6.0, user_id="u1", agent_id="a2")
    assert s.stats("u1", "a1")["total_memories"] == 1
    assert s.stats("u1", "a2")["total_memories"] == 1
    assert s.stats()["total_memories"] == 0


def test_dedup_merge(tmp_path):
    s = make_store(tmp_path)
    id1 = s.add("preference", "喜欢冰美式", vec(1.0), 5.0)
    id2 = s.add("preference", "喜欢冰美式", vec(0.99), 8.0)
    assert id1 == id2
    hits = s.search(vec(1.0), top_k=5, threshold=0.0)
    assert len(hits) == 1
    assert hits[0]["importance"] == 8.0


def test_conflict_goes_pending(tmp_path):
    s = make_store(tmp_path)
    s.add("preference", "喜欢冰美式", vec(1.0), 6.0)
    s.add("preference", "讨厌冰美式", vec(0.90), 7.0)
    # pending 不参与检索
    hits = s.search(vec(1.0), top_k=5, threshold=0.0)
    assert len(hits) == 1
    assert hits[0]["content"] == "喜欢冰美式"
    # 但列表可见，状态为 pending
    all_items = s.list_all()
    assert len(all_items) == 2
    assert {m["status"] for m in all_items} == {"active", "pending"}


def test_delete(tmp_path):
    s = make_store(tmp_path)
    mid = s.add("event", "一起散步", vec(1.0), 7.0)
    assert s.delete(mid) is True
    assert s.stats()["total_memories"] == 0
    assert s.delete(mid) is False


def test_core_profile(tmp_path):
    s = make_store(tmp_path)
    s.add("preference", "用户生日是 3 月 14 日", vec(1.0), 9.0, is_core=True)
    s.add("event", "昨天一起看了电影", vec(0.5), 7.0, is_core=False)
    core = s.get_core(limit=10)
    assert len(core) == 1
    assert core[0]["content"] == "用户生日是 3 月 14 日"
    assert core[0]["type"] == "preference"


def test_core_flag_survives_merge(tmp_path):
    s = make_store(tmp_path)
    s.add("preference", "喜欢喝咖啡", vec(1.0), 6.0, is_core=False)
    # 同一条记忆再次出现且标记 core，合并后 core 应保留
    s.add("preference", "用户喜欢喝咖啡", vec(1.0), 8.0, is_core=True)
    core = s.get_core(limit=10)
    assert len(core) == 1


def test_consolidate_resolves_conflict(tmp_path):
    s = make_store(tmp_path)
    s.add("preference", "喜欢冰美式", vec(1.0), 6.0)
    s.add("preference", "讨厌冰美式", vec(0.90), 7.0)
    stats = s.consolidate()
    assert stats["conflicts_resolved"] == 1
    items = s.list_all()
    assert len(items) == 1
    assert items[0]["status"] == "active"
    assert items[0]["content"] == "讨厌冰美式"


def test_consolidate_merges_duplicates(tmp_path):
    s = make_store(tmp_path)
    # 直接写库，模拟 add 时代漏掉的历史重复数据
    with s._conn() as conn:
        conn.execute(
            """
            INSERT INTO memories (user_id, agent_id, status, type, content, embedding, importance, created_at, updated_at)
            VALUES ('default', 'default', 'active', 'fact', '用户是程序员', ?, 6.0, ?, ?)
            """,
            (json.dumps(vec(0.96)), time.time(), time.time()),
        )
        conn.execute(
            """
            INSERT INTO memories (user_id, agent_id, status, type, content, embedding, importance, created_at, updated_at)
            VALUES ('default', 'default', 'active', 'fact', '用户是程序员', ?, 8.0, ?, ?)
            """,
            (json.dumps(vec(1.0)), time.time(), time.time()),
        )
    stats = s.consolidate()
    assert stats["duplicates_merged"] == 1
    items = s.list_all()
    assert len(items) == 1
    assert items[0]["importance"] == 8.0


def test_consolidate_decays_stale(tmp_path):
    s = make_store(tmp_path)
    mid = s.add("fact", "很久没提的旧事", vec(1.0), 10.0)
    with s._conn() as conn:
        conn.execute(
            "UPDATE memories SET created_at=?, access_count=0 WHERE id=?",
            (1000000000.0, mid),  # 2001 年
        )
    stats = s.consolidate(decay_days=30)
    assert stats["decayed"] == 1
    items = s.list_all()
    assert items[0]["importance"] < 10.0
