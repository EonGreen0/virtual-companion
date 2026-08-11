"""虚拟恋人记忆网关：OpenAI 兼容接口，注入记忆 → 转发 DeepSeek → 异步提取记忆。

角色无关：人格由上游（LobeHub Agent / 微信桥接）提供，网关只负责记忆。
"""

import asyncio
import json
import logging
import os
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import quote

import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel

from memory_store import MemoryStore


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("gateway")

BASE_DIR = Path(__file__).parent
load_dotenv(BASE_DIR / ".env")

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash")
COMPANION_NAME = os.getenv("COMPANION_NAME", "AI")
GATEWAY_USER_ID = os.getenv("GATEWAY_USER_ID", "default")
# 默认 agent 命名空间保持 'default'（与历史记忆一致）；需要按角色隔离时再显式设置
GATEWAY_AGENT_ID = os.getenv("GATEWAY_AGENT_ID", "default")
_DEFAULT_PERSONA = ",".join(
    [
        str(BASE_DIR.parent / "persona" / "喜多郁代-人格卡-xml.md"),
        str(BASE_DIR.parent / "persona" / "伴侣行为规范.md"),
    ]
)
PERSONA_FILES = [p.strip() for p in os.getenv("PERSONA_FILE", _DEFAULT_PERSONA).split(",") if p.strip()]
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "bge-m3")
PORT = int(os.getenv("GATEWAY_PORT", "8080"))
MEMORY_TOP_K = int(os.getenv("MEMORY_TOP_K", "8"))
MEMORY_SIMILARITY_THRESHOLD = float(os.getenv("MEMORY_SIMILARITY_THRESHOLD", "0.30"))
GATEWAY_API_KEY = os.getenv("GATEWAY_API_KEY", "")


async def verify_api_key(
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
) -> None:
    """可选鉴权：设置了 GATEWAY_API_KEY 后，所有模型与记忆接口都需要正确 Key。"""
    if not GATEWAY_API_KEY:
        return
    token = x_api_key
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    if not token or token != GATEWAY_API_KEY:
        raise HTTPException(status_code=401, detail="invalid gateway api key")

store = MemoryStore(BASE_DIR / "memory.db", OLLAMA_URL, EMBEDDING_MODEL)
app = FastAPI(title="Companion Memory Gateway")


def resolve_scope(body: dict, request: Request) -> tuple[str, str]:
    """请求作用域：body 字段优先，其次请求头，最后环境变量默认值。"""
    user_id = body.get("user_id") or request.headers.get("X-User-Id") or GATEWAY_USER_ID
    agent_id = body.get("agent_id") or request.headers.get("X-Agent-Id") or GATEWAY_AGENT_ID
    return str(user_id), str(agent_id)


def query_scope(request: Request) -> tuple[str, str]:
    """可视化 / 管理接口的查询参数作用域。"""
    user_id = request.query_params.get("user_id") or GATEWAY_USER_ID
    agent_id = request.query_params.get("agent_id") or GATEWAY_AGENT_ID
    return str(user_id), str(agent_id)


def load_persona() -> str:
    """读取人格卡 + 通用行为规范；请求本身不带 system 时自动注入。"""
    parts = []
    for path in PERSONA_FILES:
        try:
            parts.append(Path(path).read_text(encoding="utf-8").strip())
        except OSError as exc:
            logger.warning("人格文件读取失败（%s），已跳过", exc)
    return "\n\n".join(parts)


async def consolidation_loop() -> None:
    """每天 03:00 自动执行记忆整理：冲突处理、去重合并、遗忘降权。"""
    while True:
        now = datetime.now()
        next_run = now.replace(hour=3, minute=0, second=0, microsecond=0)
        if next_run <= now:
            next_run += timedelta(days=1)
        await asyncio.sleep((next_run - now).total_seconds())
        try:
            scopes = store.list_scopes()
            if not scopes:
                logger.info("夜间记忆整理：暂无记忆")
                continue
            for scope in scopes:
                stats = store.consolidate(
                    user_id=scope["user_id"], agent_id=scope["agent_id"]
                )
                logger.info(
                    "夜间记忆整理 [%s / %s]: %s",
                    scope["user_id"],
                    scope["agent_id"],
                    stats,
                )
        except Exception as exc:
            logger.warning("夜间记忆整理失败: %s", exc)


@app.on_event("startup")
async def startup() -> None:
    asyncio.create_task(consolidation_loop())
    logger.info("记忆整理任务已调度（每天 03:00）")


@app.get("/")
async def root():
    """LobeHub 连通性检测会请求根路径，返回 200 即可。"""
    return {"status": "ok", "service": "companion-memory-gateway", "message": "memory gateway is running"}


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "memories": store.stats(),
        "companion": COMPANION_NAME,
        "scopes": len(store.list_scopes()),
    }


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
{"memories":[{"type":"fact|preference|event","content":"一句话描述","importance":1到10,"core":false}]}

规则：
- fact：关于用户的客观事实（身份、工作、习惯、家人等）
- preference：用户的喜好/厌恶/雷点（语气、食物、话题等）
- event：你们之间的共同事件或关系里程碑（约定、纪念日、一起做过的事）
- 严格区分人称：只有用户亲口说过的关于自己的话，才能记为用户的 fact/preference；
  角色（喜多）对自己外貌、习惯的自我描述，绝不能记成用户的特征；
  归属不确定的信息一律不提取
- core：只有长期稳定、几乎不会变的核心信息才标 true（生日、姓名、职业、永久禁忌、长期稳定的喜好），
  这类信息会常驻在每次对话中，所以务必宁缺毋滥，模棱两可的一律 false
- 每段对话最多提取 5 条，宁缺毋滥；避免流水账（"今天吃了饭"这种不值得记）
- 只用中文输出，不要解释

对话：
"""


async def extract_memories(dialog_text: str, user_id: str, agent_id: str) -> None:
    """后台异步：用 DeepSeek 从对话中提取记忆并写入指定作用域。"""
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
            is_core = bool(item.get("core", False))
            if not text or type_ not in ("fact", "preference", "event"):
                continue
            emb = await store.embed(text)
            store.add(
                type_, text, emb, importance,
                user_id=user_id, agent_id=agent_id, is_core=is_core,
            )
        logger.info("已提取 %d 条候选记忆", len(parsed.get("memories", [])))
    except Exception as exc:
        logger.warning("记忆提取失败: %s", exc)


@app.post("/v1/chat/completions", dependencies=[Depends(verify_api_key)])
async def chat_completions(request: Request):
    body = await request.json()
    messages = body.get("messages", [])
    stream = body.get("stream", False)
    model = body.get("model") or DEEPSEEK_MODEL
    skip_extract = bool(body.get("skip_extract", False))
    wechat_style = bool(body.get("wechat_style", False))
    voice_style = bool(body.get("voice_style", False))
    user_id, agent_id = resolve_scope(body, request)

    user_text = extract_user_text(messages)
    memory_block = ""
    retrieved = []
    core_block = ""
    try:
        core_block = build_memory_block(
            store.get_core(limit=10, user_id=user_id, agent_id=agent_id)
        )
    except Exception as exc:
        logger.warning("核心画像读取失败: %s", exc)
    if user_text.strip():
        try:
            query_emb = await store.embed(user_text)
            retrieved = store.search(
                query_emb,
                top_k=MEMORY_TOP_K,
                threshold=MEMORY_SIMILARITY_THRESHOLD,
                user_id=user_id,
                agent_id=agent_id,
            )
            memory_block = build_memory_block(retrieved)
            for m in retrieved:
                store.mark_used(m["id"])
        except Exception as exc:
            logger.warning("记忆检索失败(降级为无记忆): %s", exc)

    upstream_messages = []
    for msg in messages:
        upstream_messages.append(msg)
    has_system = any(m.get("role") == "system" and str(m.get("content", "")).strip() for m in upstream_messages)
    if not has_system:
        persona = load_persona()
        if persona:
            upstream_messages.insert(0, {"role": "system", "content": persona})
    if core_block or memory_block:
        base = upstream_messages[0] if upstream_messages and upstream_messages[0].get("role") == "system" else {"role": "system", "content": ""}
        if upstream_messages and upstream_messages[0].get("role") == "system":
            base = upstream_messages[0]
        else:
            upstream_messages.insert(0, base)
        memory_section = ""
        if core_block:
            memory_section += "【你对 TA 的核心了解（永远记得）】\n" + core_block + "\n\n"
        if memory_block:
            memory_section += "【相关回忆】\n" + memory_block + "\n\n"
        base["content"] = (
            base.get("content", "")
            + "\n\n"
            + memory_section
            + "自然地使用这些信息，但不要刻意提及「记忆」「回忆」这类词。"
        )
    if wechat_style:
        style_note = (
            "\n\n【微信聊天场景】你现在是在和用户用微信聊天。回复要像真人发微信："
            "口语化短句，用换行分段，每段不超过 40 字，最多 3 段，段与段之间空行。"
            "不要使用 Markdown、列表或标题。"
        )
        base_sys = upstream_messages[0] if upstream_messages and upstream_messages[0].get("role") == "system" else None
        if base_sys is not None:
            base_sys["content"] = (base_sys.get("content", "") or "") + style_note
        else:
            upstream_messages.insert(0, {"role": "system", "content": style_note.strip()})
    if voice_style:
        voice_note = (
            "\n\n【语音回复模式】你的回复将用语音朗读给用户听。要求：\n"
            "1. 口语化、适合朗读：不要 Markdown、括号动作、表情符号\n"
            "2. 短句，全文 60 字以内，像真人发语音\n"
            "3. 最后单独一行输出情绪标签：<emotion>none|happy|sad|angry</emotion>\n"
            "4. 情绪必须克制：默认 none；只有内容本身确实需要强烈情绪（如大悲大喜）才用 happy/sad/angry；"
            "不要夸张、不要每句都带情绪、避免戏剧化"
        )
        base_sys = upstream_messages[0] if upstream_messages and upstream_messages[0].get("role") == "system" else None
        if base_sys is not None:
            base_sys["content"] = (base_sys.get("content", "") or "") + voice_note
        else:
            upstream_messages.insert(0, {"role": "system", "content": voice_note.strip()})
    if retrieved:
        logger.info(
            "检索命中 %d 条记忆（最高分 %.3f），注入成功",
            len(retrieved),
            retrieved[0]["score"],
        )

    payload = {**body, "model": model, "messages": upstream_messages}
    headers = {
        "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
        "Content-Type": "application/json",
    }

    async def proxy_stream():
        collected = []
        collected_reasoning = []
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
                                elif isinstance(delta.get("reasoning_content"), str):
                                    collected_reasoning.append(delta["reasoning_content"])
                            except json.JSONDecodeError:
                                pass
        full_reply = "".join(collected) or "".join(collected_reasoning)
        if full_reply and not skip_extract:
            dialog = f"用户: {user_text[:1500]}\n{COMPANION_NAME}: {full_reply[:2000]}"
            asyncio.create_task(extract_memories(dialog, user_id, agent_id))

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
            message = data.get("choices", [{}])[0].get("message", {})
            full_reply = message.get("content") or message.get("reasoning_content") or ""
            if full_reply and not skip_extract:
                dialog = f"用户: {user_text[:1500]}\n{COMPANION_NAME}: {full_reply[:2000]}"
                asyncio.create_task(extract_memories(dialog, user_id, agent_id))
            return JSONResponse(content=data)

    if stream:
        return StreamingResponse(proxy_stream(), media_type="text/event-stream")
    return await proxy_nonstream()


@app.post("/chat/completions", dependencies=[Depends(verify_api_key)])
async def chat_completions_legacy(request: Request):
    """兼容 DeepSeek 风格的不带 /v1 路径。"""
    return await chat_completions(request)


@app.get("/v1/models", dependencies=[Depends(verify_api_key)])
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


@app.get("/models", dependencies=[Depends(verify_api_key)])
async def models_legacy():
    return await models()


@app.get("/api/memories", dependencies=[Depends(verify_api_key)])
async def list_memories(request: Request):
    user_id, agent_id = query_scope(request)
    return {
        "user_id": user_id,
        "agent_id": agent_id,
        "memories": store.list_all(user_id=user_id, agent_id=agent_id),
        "stats": store.stats(user_id=user_id, agent_id=agent_id),
    }


@app.get("/memories", response_class=HTMLResponse)
async def memories_page(request: Request):
    """记忆可视化页面：查看 / 删除她记住的内容。"""
    user_id, agent_id = query_scope(request)
    items = store.list_all(user_id=user_id, agent_id=agent_id)
    scopes = store.list_scopes()
    scope_links = " | ".join(
        f'<a href="/memories?user_id={quote(s["user_id"])}&agent_id={quote(s["agent_id"])}">'
        f'{s["user_id"]} / {s["agent_id"]}（{s["total_memories"]} 条）</a>'
        for s in scopes
    ) or "（暂无记忆）"
    rows = "\n".join(
        f"""
        <tr>
          <td>{m['id']}</td>
          <td>{m['type']}</td>
          <td>{m['status']}</td>
          <td class="content">{m['content']}</td>
          <td>{m['importance']:.0f}</td>
          <td>{m['access_count']}</td>
          <td><button onclick="delMem({m['id']}, '{quote(user_id)}', '{quote(agent_id)}')">删除</button></td>
        </tr>"""
        for m in items
    )
    return f"""<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>她的记忆</title>
<style>
  body {{ font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 1000px; padding: 0 1rem; }}
  h1 {{ color: #333; }}
  table {{ width: 100%; border-collapse: collapse; }}
  th, td {{ border: 1px solid #ddd; padding: 8px 12px; text-align: left; font-size: 14px; }}
  th {{ background: #f5f5f5; }}
  .content {{ max-width: 480px; }}
  button {{ cursor: pointer; }}
  .stats {{ color: #666; margin-bottom: 1rem; }}
</style>
</head>
<body>
  <h1>🧠 她的记忆</h1>
  <p class="stats">当前命名空间：<b>{user_id} / {agent_id}</b>（共 {len(items)} 条）</p>
  <p class="stats">切换：{scope_links}</p>
  <table>
    <thead><tr><th>ID</th><th>类型</th><th>状态</th><th>内容</th><th>重要度</th><th>被想起次数</th><th>操作</th></tr></thead>
    <tbody>{rows}</tbody>
  </table>
  <script>
    async function delMem(id, uid, aid) {{
      if (!confirm('确定删除这条记忆？')) return;
      const r = await fetch('/api/memories/' + id + '?user_id=' + uid + '&agent_id=' + aid, {{ method: 'DELETE' }});
      if (r.ok) location.reload();
    }}
  </script>
</body>
</html>"""


@app.delete("/api/memories/{memory_id}", dependencies=[Depends(verify_api_key)])
async def delete_memory(memory_id: int, request: Request):
    user_id, agent_id = query_scope(request)
    return {
        "deleted": store.delete(memory_id, user_id=user_id, agent_id=agent_id),
        "user_id": user_id,
        "agent_id": agent_id,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
