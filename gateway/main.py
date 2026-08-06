"""虚拟恋人记忆网关：OpenAI 兼容接口，注入记忆 → 转发 DeepSeek → 异步提取记忆。"""

import asyncio
import json
import os
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from memory_store import MemoryStore


BASE_DIR = Path(__file__).parent
load_dotenv(BASE_DIR / ".env")

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "bge-m3")
PORT = int(os.getenv("GATEWAY_PORT", "8080"))
MEMORY_TOP_K = int(os.getenv("MEMORY_TOP_K", "8"))
MEMORY_SIMILARITY_THRESHOLD = float(os.getenv("MEMORY_SIMILARITY_THRESHOLD", "0.30"))

store = MemoryStore(BASE_DIR / "memory.db", OLLAMA_URL, EMBEDDING_MODEL)
app = FastAPI(title="Companion Memory Gateway")


@app.get("/")
async def root():
    """LobeHub 连通性检测会请求根路径，返回 200 即可。"""
    return {"status": "ok", "service": "companion-memory-gateway", "message": "memory gateway is running"}


def extract_user_text(messages: list[dict]) -> str:
    for msg in reversed(messages):
        if msg.get("role") == "user":
            content = msg.get("content", "")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                parts = [
                    item.get("text", "")
                    for item in content
                    if isinstance(item, dict) and item.get("type") == "text"
                ]
                return "\n".join(parts)
    return ""


def build_memory_block(memories: list[dict]) -> str:
    if not memories:
        return ""
    lines = []
    for m in memories:
        lines.append(f"- [{m['type']}] {m['content']}")
    return "\n".join(lines)


EXTRACT_PROMPT = """你是记忆提取器。从下面这段对话中，提取对一段长期亲密关系值得记住的信息。
只提取明确表达或可可靠推断的事实，不要编造。输出 JSON：
{"memories":[{"type":"fact|preference|event","content":"一句话描述","importance":1到10}]}

规则：
- fact：关于用户的客观事实（身份、工作、习惯、家人等）
- preference：用户的喜好/厌恶/雷点（语气、食物、话题等）
- event：你们之间的共同事件或关系里程碑（约定、纪念日、一起做过的事）
- 每段对话最多提取 5 条，宁缺毋滥
- 只用中文输出，不要解释

对话：
"""


async def extract_memories(dialog_text: str) -> None:
    """后台异步：用 DeepSeek 从对话中提取记忆并写入记忆库。"""
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{DEEPSEEK_BASE_URL}/chat/completions",
                headers={"Authorization": f"Bearer {DEEPSEEK_API_KEY}"},
                json={
                    "model": DEEPSEEK_MODEL,
                    "messages": [
                        {"role": "system", "content": EXTRACT_PROMPT},
                        {"role": "user", "content": dialog_text[:6000]},
                    ],
                    "temperature": 0.2,
                    "max_tokens": 2000,
                },
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"]
            content = content.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
            parsed = json.loads(content)
        for item in parsed.get("memories", []):
            type_ = item.get("type", "fact")
            text = item.get("content", "").strip()
            importance = float(item.get("importance", 5))
            if not text or type_ not in ("fact", "preference", "event"):
                continue
            emb = await store.embed(text)
            store.add(type_, text, emb, importance)
        print(f"[memory] 已提取 {len(parsed.get('memories', []))} 条候选记忆")
    except Exception as exc:
        print(f"[memory] 提取失败: {exc}")


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    body = await request.json()
    messages = body.get("messages", [])
    stream = body.get("stream", False)
    model = body.get("model") or DEEPSEEK_MODEL

    user_text = extract_user_text(messages)
    memory_block = ""
    retrieved = []
    if user_text.strip():
        try:
            query_emb = await store.embed(user_text)
            retrieved = store.search(query_emb, top_k=MEMORY_TOP_K, threshold=MEMORY_SIMILARITY_THRESHOLD)
            memory_block = build_memory_block(retrieved)
        except Exception as exc:
            print(f"[memory] 检索失败(降级为无记忆): {exc}")

    upstream_messages = []
    for msg in messages:
        upstream_messages.append(msg)
    if memory_block:
        base = upstream_messages[0] if upstream_messages and upstream_messages[0].get("role") == "system" else {"role": "system", "content": ""}
        if upstream_messages and upstream_messages[0].get("role") == "system":
            base = upstream_messages[0]
        else:
            upstream_messages.insert(0, base)
        base["content"] = (
            base.get("content", "")
            + "\n\n【你的长期记忆（按相关度排序）】\n"
            + memory_block
            + "\n\n自然地使用这些记忆，但不要刻意提及「记忆」这个词。"
        )
    with open(BASE_DIR / "gateway.log", "a", encoding="utf-8") as logf:
        logf.write(
            f"user_text: {user_text[:120]}\n"
            f"retrieved: {len(retrieved)} 条\n"
            f"injected_system_tail: ...{upstream_messages[0].get('content', '')[-600:]}\n"
            "---\n"
        )

    payload = {**body, "model": model, "messages": upstream_messages}
    headers = {
        "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
        "Content-Type": "application/json",
    }

    async def proxy_stream():
        collected = []
        async with httpx.AsyncClient(timeout=600) as client:
            async with client.stream("POST", f"{DEEPSEEK_BASE_URL}/chat/completions", headers=headers, json=payload) as resp:
                if resp.status_code != 200:
                    error_body = (await resp.aread()).decode(errors="ignore")
                    yield f"data: {json.dumps({'error': {'message': error_body[:500], 'status_code': resp.status_code}})}\n\n"
                    return
                async for line in resp.aiter_lines():
                    if line.startswith("data:"):
                        yield line + "\n\n"
                        data = line[5:].strip()
                        if data and data != "[DONE]":
                            try:
                                chunk = json.loads(data)
                                delta = chunk.get("choices", [{}])[0].get("delta", {})
                                if isinstance(delta.get("content"), str):
                                    collected.append(delta["content"])
                            except json.JSONDecodeError:
                                pass
        if collected:
            dialog = f"用户: {user_text[:1500]}\n喜多: {''.join(collected)[:2000]}"
            asyncio.create_task(extract_memories(dialog))

    async def proxy_nonstream():
        async with httpx.AsyncClient(timeout=600) as client:
            resp = await client.post(
                f"{DEEPSEEK_BASE_URL}/chat/completions", headers=headers, json=payload
            )
            if resp.status_code != 200:
                return JSONResponse(
                    status_code=resp.status_code,
                    content={"error": {"message": resp.text[:500], "status_code": resp.status_code}},
                )
            data = resp.json()
            if collected := data.get("choices", [{}])[0].get("message", {}).get("content"):
                dialog = f"用户: {user_text[:1500]}\n喜多: {collected[:2000]}"
                asyncio.create_task(extract_memories(dialog))
            return JSONResponse(content=data)

    if stream:
        return StreamingResponse(proxy_stream(), media_type="text/event-stream")
    return await proxy_nonstream()


@app.post("/chat/completions")
async def chat_completions_legacy(request: Request):
    """兼容 DeepSeek 风格的不带 /v1 路径。"""
    return await chat_completions(request)


@app.get("/v1/models")
async def models():
    return {
        "object": "list",
        "data": [
            {
                "id": DEEPSEEK_MODEL,
                "object": "model",
                "owned_by": "deepseek",
            }
        ],
    }


@app.get("/models")
async def models_legacy():
    return await models()


@app.get("/api/memories")
async def list_memories():
    return {"memories": store.list_all(), "stats": store.stats()}


@app.delete("/api/memories/{memory_id}")
async def delete_memory(memory_id: int):
    return {"deleted": store.delete(memory_id)}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
