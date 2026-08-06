"""轻量记忆库：SQLite 存储 + Ollama embedding + 余弦相似度检索。"""

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
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)"
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

    def search(self, embedding: list[float], top_k: int = 8, threshold: float = 0.30) -> list[dict]:
        with self._conn() as conn:
            rows = conn.execute("SELECT * FROM memories").fetchall()
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
                    "type": row["type"],
                    "content": row["content"],
                    "importance": row["importance"],
                    "score": round(score, 4),
                    "created_at": row["created_at"],
                }
            )
        return result

    def add(self, type_: str, content: str, embedding: list[float], importance: float) -> int:
        """新增记忆；若与现有记忆高度相似则合并更新。"""
        with self._conn() as conn:
            rows = conn.execute("SELECT * FROM memories").fetchall()
            for row in rows:
                sim = self._cosine(embedding, json.loads(row["embedding"]))
                if sim >= 0.92:
                    new_importance = max(row["importance"], importance)
                    conn.execute(
                        "UPDATE memories SET content=?, importance=?, updated_at=? WHERE id=?",
                        (content, new_importance, time.time(), row["id"]),
                    )
                    return row["id"]
            cur = conn.execute(
                """
                INSERT INTO memories (type, content, embedding, importance, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    type_,
                    content,
                    json.dumps(embedding),
                    importance,
                    time.time(),
                    time.time(),
                ),
            )
            return cur.lastrowid

    def mark_used(self, memory_id: int) -> None:
        with self._conn() as conn:
            conn.execute(
                "UPDATE memories SET access_count=access_count+1, last_used_at=? WHERE id=?",
                (time.time(), memory_id),
            )

    def list_all(self) -> list[dict]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT id, type, content, importance, access_count, created_at FROM memories ORDER BY created_at DESC"
            ).fetchall()
        return [dict(r) for r in rows]

    def delete(self, memory_id: int) -> bool:
        with self._conn() as conn:
            cur = conn.execute("DELETE FROM memories WHERE id=?", (memory_id,))
            return cur.rowcount > 0

    def stats(self) -> dict:
        with self._conn() as conn:
            total = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
        return {"total_memories": total}
