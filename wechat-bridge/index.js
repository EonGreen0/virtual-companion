/**
 * 微信 iLink 桥接服务
 *
 * 职责：
 * 1. 扫码登录 iLink（凭证持久化，之后自动重连）
 * 2. 长轮询接收微信消息
 * 3. 维护每个用户的最近对话历史
 * 4. 调用记忆网关（人格 + 记忆注入由网关负责）
 * 5. 以拟人节奏回复（正在输入 + 短延迟）
 *
 * 用法：
 *   npm start        # 正常启动（自动复用凭证）
 *   npm run login    # 仅登录（扫码授权后退出，用于首次/换号）
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { WeixinBot } from "@chnak/weixin-bot";
import { ProactiveScheduler, splitMessage } from "./proactive.js";
import { setTimeout as delay } from "node:timers/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GATEWAY_URL = process.env.GATEWAY_URL || "http://127.0.0.1:8080";
const GATEWAY_MODEL = process.env.GATEWAY_MODEL || "deepseek-v4-flash";
const TOKEN_PATH = process.env.TOKEN_PATH || path.join(__dirname, "credentials.json");
const HISTORY_LIMIT = 10; // 每用户保留的对话轮数
const TYPING_INTERVAL_MS = 3000; // 模拟持续「正在输入」
const REPLY_PART_DELAY_MS = 1200; // 回复分包发送间隔
const REPLY_MAX_PARTS = 3; // 回复最多拆几条
const REPLY_MAX_PART_LENGTH = 42; // 每段最大字数
const DEBOUNCE_MS = parseInt(process.env.MESSAGE_DEBOUNCE_MS ?? "3500", 10); // 消息聚合等待
const USERS_FILE = path.join(__dirname, "known-users.json");
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT ?? "9090", 10);

/** 每用户的对话历史：userId -> [{role, content}] */
const history = new Map();
/** 已知用户：userId -> { lastActive }（主动消息需要知道发给谁） */
const knownUsers = new Map();
/** 待聚合消息：userId -> { items: [], timer } */
const pendingMessages = new Map();

async function loadKnownUsers() {
  try {
    const raw = await readFile(USERS_FILE, "utf8");
    for (const [userId, info] of Object.entries(JSON.parse(raw))) {
      knownUsers.set(userId, info);
    }
  } catch {
    /* 首次运行没有文件，正常 */
  }
}

async function saveKnownUsers() {
  try {
    await writeFile(USERS_FILE, JSON.stringify(Object.fromEntries(knownUsers), null, 2));
  } catch (err) {
    console.error(`[bridge] 保存用户列表失败: ${err.message}`);
  }
}

/** 调用记忆网关生成回复（人格 + 记忆由网关注入） */
async function askGateway(messages, { wechatStyle = false } = {}) {
  const resp = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GATEWAY_MODEL,
      stream: false,
      messages,
      ...(wechatStyle ? { wechat_style: true } : {}),
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`gateway ${resp.status}: ${body.slice(0, 300)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content ?? "";
}

/** 保持「正在输入」直到回复完成 */
async function keepTyping(bot, userId, task) {
  const timer = setInterval(() => {
    bot.sendTyping(userId).catch(() => {});
  }, TYPING_INTERVAL_MS);
  try {
    return await task();
  } finally {
    clearInterval(timer);
    bot.stopTyping(userId).catch(() => {});
  }
}

async function handleMessage(bot, userId, items) {
  console.log(`[bridge] 开始处理 ${items.length} 条聚合消息`);

  // 合并多条消息：文本直接拼接，非文本消息标注占位
  const mergedParts = [];
  for (const m of items) {
    const text = (m.text || "").trim();
    if (text) {
      mergedParts.push(text);
    } else if (m.type && m.type !== "text") {
      const labels = { image: "一张图片", voice: "一条语音", file: "一个文件", video: "一个视频" };
      mergedParts.push(`（用户发来${labels[m.type] ?? "一条消息"}，内容暂不可见）`);
    }
  }
  const combined = mergedParts.join("\n");
  if (!combined) return;

  const prev = history.get(userId) || [];
  const messages = [
    ...prev.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: `用户连续发来几条消息：\n${combined}` },
  ];

  let reply;
  try {
    console.log("[bridge] 调用网关...");
    reply = await keepTyping(bot, userId, () => askGateway(messages, { wechatStyle: true }));
    console.log(`[bridge] 网关返回 ${reply.length} 字`);
  } catch (err) {
    console.error(`[bridge] 网关调用失败: ${err.message}`);
    reply = "唔……我刚才走神了一下，你能再说一遍吗？";
  }

  // 更新会话历史
  prev.push({ role: "user", content: combined }, { role: "assistant", content: reply });
  if (prev.length > HISTORY_LIMIT * 2) {
    prev.splice(0, prev.length - HISTORY_LIMIT * 2);
  }
  history.set(userId, prev);

  // 拟人化分包发送：拆成 2~3 条短消息，失败自动降级为合并发送
  const parts = splitMessage(reply, REPLY_MAX_PART_LENGTH, REPLY_MAX_PARTS);
  console.log(`[bridge] 分包 ${parts.length} 条，开始发送`);
  const replyTarget = items[items.length - 1]; // 用最新一条消息的 context_token
  try {
    for (const part of parts) {
      await bot.reply(replyTarget, part);
      await delay(REPLY_PART_DELAY_MS);
    }
  } catch (sendErr) {
    const remaining = parts.join("");
    console.warn(`[bridge] 分包发送失败（${sendErr.message}），降级为整条发送`);
    try {
      await bot.reply(replyTarget, remaining);
    } catch (fallbackErr) {
      console.error(`[bridge] 降级发送也失败: ${fallbackErr.message}`);
    }
  }
  console.log("[bridge] 发送完成");
  console.log(
    `[bridge] ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} ${userId}: ${combined.slice(0, 40)} → ${reply.length} 字`,
  );
}

function enqueueMessage(bot, msg) {
  const userId = msg.userId;
  knownUsers.set(userId, { lastActive: Date.now() });
  saveKnownUsers();

  let entry = pendingMessages.get(userId);
  if (!entry) {
    entry = { items: [], timer: null };
    pendingMessages.set(userId, entry);
  }
  entry.items.push(msg);
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    pendingMessages.delete(userId);
    handleMessage(bot, userId, entry.items).catch((err) =>
      console.error(`[bridge] 处理消息失败: ${err}`),
    );
  }, DEBOUNCE_MS);
}

async function main() {
  const forceLogin = process.argv.includes("--login");
  const loginOnly = process.argv.includes("--login-only") || forceLogin;
  const poke = process.argv.includes("--poke");
  await loadKnownUsers();
  const bot = new WeixinBot({
    tokenPath: TOKEN_PATH,
    onError: (err) => console.error(`[bridge] 轮询错误: ${err}`),
  });

  if (loginOnly) {
    console.log("[bridge] 开始扫码登录（请在微信中打开下面的链接完成授权）...");
    await bot.login({ force: true });
    console.log("[bridge] 登录成功，凭证已保存");
    process.exit(0);
  }

  console.log("[bridge] 启动（如需重新扫码请用 npm run login）...");
  await bot.login({ force: false });
  console.log("[bridge] 登录成功，开始监听微信消息");

  bot.onMessage((msg) => {
    enqueueMessage(bot, msg);
  });

  const scheduler = new ProactiveScheduler(bot, {
    getUsers: () =>
      [...knownUsers.entries()].map(([userId, info]) => ({ userId, lastActive: info.lastActive })),
  });
  if (poke) {
    console.log("[bridge] 手动触发一次主动消息...");
    await scheduler.poke();
    process.exit(0);
  }
  await scheduler.start();

  // 本地控制接口（仅 127.0.0.1）：手动触发主动消息 / 查看状态
  const controlServer = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/poke") {
        await scheduler.poke();
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname === "/status") {
        res.end(JSON.stringify(scheduler.status()));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err.message }));
    }
  });
  controlServer.listen(BRIDGE_PORT, "127.0.0.1");
  console.log(`[bridge] 控制接口 http://127.0.0.1:${BRIDGE_PORT}（/poke 手动触发，/status 状态）`);

  await bot.run();
}

main().catch((err) => {
  console.error("[bridge] 启动失败:", err);
  process.exit(1);
});
