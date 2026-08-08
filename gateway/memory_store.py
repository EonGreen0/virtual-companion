"""轻量记忆库：SQLite 存储 + Ollama embedding + 余弦相似度检索。

记忆按 (user_id, agent_id) 隔离，避免多用户 / 多角色串记忆。
"""

import json
import math
import sqlite3
import time
from pathlib import Path

import httpx
import numpy as np


class MemoryStore:
    def __init__(self, db_path: str, ollama_url: str, embedding_model: str):
        self.db_path = Path(db_path)
        self.ollama_url = ollama_url.rstrip("/")
        self.embedding_model = embedding_model
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._conn() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL DEFAULT 'default',
                    agent_id TEXT NOT NULL DEFAULT 'default',
                    status TEXT NOT NULL DEFAULT 'active',
                    type TEXT NOT NULL DEFAULT 'fact',
                    content TEXT NOT NULL,
                    embedding TEXT NOT NULL,
                    importance REAL NOT NULL DEFAULT 5,
                    access_count INTEGER NOT NULL DEFAULT 0,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    last_used_at REAL
                )
                """
            )
            # 旧库迁移：补上 user_id / agent_id 列
            cols = [row[1] for row in conn.execute("PRAGMA table_info(memories)")]
            if "user_id" not in cols:
                conn.execute("ALTER TABLE memories ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default'")
            if "agent_id" not in cols:
                conn.execute("ALTER TABLE memories ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'default'")
            if "status" not in cols:
                conn.execute("ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active'")
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(user_id, agent_id)"
            )

    async def embed(self, text: str) -> list[float]:
        """调用本地 Ollama 生成向量。"""
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{self.ollama_url}/api/embeddings",
                json={"model": self.embedding_model, "prompt": text},
            )
            resp.raise_for_status()
            return resp.json()["embedding"]

    def _cosine(self, a: list[float], b: list[float]) -> float:
        va, vb = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
        denom = float(np.linalg.norm(va) * np.linalg.norm(vb))
        if denom == 0:
            return 0.0
        return float(np.dot(va, vb) / denom)

    def _time_decay(self, created_at: float, days_half_life: float = 90.0) -> float:
        """时间衰减：久未引用的旧记忆降低权重（不删除）。"""
        age_days = (time.time() - created_at) / 86400.0
        return 0.5 ** (age_days / days_half_life)

    def search(
        self,
        embedding: list[float],
        top_k: int = 8,
        threshold: float = 0.30,
        user_id: str = "default",
        agent_id: str = "default",
    ) -> list[dict]:
        """检索记忆；只扫描同作用域内最近 5000 条，避免全表扫描失控。"""
        with self._conn() as conn:
            rows = conn.execute(
                """
                SELECT * FROM memories
                WHERE user_id = ? AND agent_id = ? AND status = 'active'
                ORDER BY updated_at DESC
                LIMIT 5000
                """,
                (user_id, agent_id),
            ).fetchall()
        scored = []
        for row in rows:
            sim = self._cosine(embedding, json.loads(row["embedding"]))
            if sim < threshold:
                continue
            importance = row["importance"] / 10.0
            score = sim * 0.6 + importance * 0.3 + self._time_decay(row["created_at"]) * 0.1
            scored.append((score, row))
        scored.sort(key=lambda x: x[0], reverse=True)
        result = []
        for score, row in scored[:top_k]:
            result.append(
                {
                    "id": row["id"],
                    "user_id": row["user_id"],
                    "agent_id": row["agent_id"],
                    "status": row["status"],
                    "type": row["type"],
                    "content": row["content"],
                    "importance": row["importance"],
                    "score": round(score, 4),
                    "created_at": row["created_at"],
                }
            )
        return result

    def add(
        self,
        type_: str,
        content: str,
        embedding: list[float],
        importance: float,
        user_id: str = "default",
        agent_id: str = "default",
    ) -> int:
        """新增记忆；若与同作用域内现有记忆高度相似则合并更新。"""
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM memories WHERE user_id = ? AND agent_id = ?",
                (user_id, agent_id),
            ).fetchall()
            for row in rows:
                sim = self._cosine(embedding, json.loads(row["embedding"]))
                if sim >= 0.92:
                    new_importance = max(row["importance"], importance)
                    conn.execute(
                        "UPDATE memories SET content=?, importance=?, updated_at=? WHERE id=?",
                        (content, new_importance, time.time(), row["id"]),
                    )
                    return row["id"]
                if 0.85 <= sim < 0.92 and content != row["content"]:
                    # 疑似冲突：内容相似但说法不同，标记为待确认，不参与检索
                    cur = conn.execute(
                        """
                        INSERT INTO memories (user_id, agent_id, status, type, content, embedding, importance, created_at, updated_at)
                        VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)
                        """,
                        (user_id, agent_id, type_, content, json.dumps(embedding), importance, time.time(), time.time()),
                    )
                    return cur.lastrowid
            cur = conn.execute(
                """
                INSERT INTO memories (user_id, agent_id, status, type, content, embedding, importance, created_at, updated_at)
                VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?)
                """,
                (
                    user_id,
                    agent_id,
                    type_,
                    content,
                    json.dumps(embedding),
                    importance,
                    time.time(),
                    time.time(),
                ),
            )
            return cur.lastrowid

    def consolidate(
        self,
        user_id: str = "default",
        agent_id: str = "default",
        merge_threshold: float = 0.95,
        conflict_threshold: float = 0.85,
        decay_days: int = 180,
    ) -> dict:
        """夜间整理：
        1. 处理 pending 冲突：保留重要度更高 / 更新的，删除另一条
        2. 合并高度相似的重复记忆
        3. 对久未使用的记忆降权
        """
        now = time.time()
        result = {"conflicts_resolved": 0, "duplicates_merged": 0, "decayed": 0, "deleted": 0}
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM memories WHERE user_id = ? AND agent_id = ?",
                (user_id, agent_id),
            ).fetchall()

            # 1) 处理 pending
            pending = [r for r in rows if r["status"] == "pending"]
            active = [r for r in rows if r["status"] == "active"]
            for p in pending:
                best = None
                best_sim = conflict_threshold
                p_emb = json.loads(p["embedding"])
                for a in active:
                    sim = self._cosine(p_emb, json.loads(a["embedding"]))
                    if sim >= best_sim:
                        best_sim = sim
                        best = a
                if best is None:
                    # 没有冲突对象，直接转正
                    conn.execute("UPDATE memories SET status='active' WHERE id=?", (p["id"],))
                    result["conflicts_resolved"] += 1
                    continue
                # 保留重要度更高 / 更新的
                keep = p if (p["importance"], p["created_at"]) >= (best["importance"], best["created_at"]) else best
                drop = best if keep is p else p
                conn.execute("DELETE FROM memories WHERE id=?", (drop["id"],))
                if keep["status"] != "active":
                    conn.execute("UPDATE memories SET status='active' WHERE id=?", (keep["id"],))
                result["conflicts_resolved"] += 1

            # 2) 合并相似重复（active 之间）
            rows = conn.execute(
                "SELECT * FROM memories WHERE user_id = ? AND agent_id = ? AND status='active' ORDER BY created_at",
                (user_id, agent_id),
            ).fetchall()
            used = set()
            for i, a in enumerate(rows):
                if a["id"] in used:
                    continue
                a_emb = json.loads(a["embedding"])
                for b in rows[i + 1 :]:
                    if b["id"] in used:
                        continue
                    sim = self._cosine(a_emb, json.loads(b["embedding"]))
                    if sim >= merge_threshold:
                        merged_importance = max(a["importance"], b["importance"])
                        merged_access = (a["access_count"] or 0) + (b["access_count"] or 0)
                        keep, drop = (a, b) if a["importance"] >= b["importance"] else (b, a)
                        conn.execute(
                            "UPDATE memories SET importance=?, access_count=?, content=?, updated_at=? WHERE id=?",
                            (merged_importance, merged_access, keep["content"], now, keep["id"]),
                        )
                        conn.execute("DELETE FROM memories WHERE id=?", (drop["id"],))
                        used.add(b["id"])
                        result["duplicates_merged"] += 1

            # 3) 降权久未使用
            cutoff = now - decay_days * 86400
            stale = conn.execute(
                """
                SELECT id, importance FROM memories
                WHERE user_id=? AND agent_id=? AND status='active'
                  AND access_count=0 AND created_at < ?
                """,
                (user_id, agent_id, cutoff),
            ).fetchall()
            for s in stale:
                new_importance = max(1.0, s["importance"] * 0.8)
                conn.execute(
                    "UPDATE memories SET importance=? WHERE id=?",
                    (new_importance, s["id"]),
                )
                result["decayed"] += 1
        return result

    def mark_used(self, memory_id: int) -> None:
        with self._conn() as conn:
            conn.execute(
                "UPDATE memories SET access_count=access_count+1, last_used_at=? WHERE id=?",
                (time.time(), memory_id),
            )

    def list_all(self, user_id: str = "default", agent_id: str = "default") -> list[dict]:
        with self._conn() as conn:
            rows = conn.execute(
                """
                SELECT id, user_id, agent_id, status, type, content, importance, access_count, created_at
                FROM memories WHERE user_id = ? AND agent_id = ?
                ORDER BY created_at DESC
                """,
                (user_id, agent_id),
            ).fetchall()
        return [dict(r) for r in rows]

    def delete(self, memory_id: int, user_id: str = "default", agent_id: str = "default") -> bool:
        with self._conn() as conn:
            cur = conn.execute(
                "DELETE FROM memories WHERE id=? AND user_id=? AND agent_id=?",
                (memory_id, user_id, agent_id),
            )
            return cur.rowcount > 0

    def stats(self, user_id: str = "default", agent_id: str = "default") -> dict:
        with self._conn() as conn:
            total = conn.execute(
                "SELECT COUNT(*) FROM memories WHERE user_id = ? AND agent_id = ?",
                (user_id, agent_id),
            ).fetchone()[0]
        return {"total_memories": total}
