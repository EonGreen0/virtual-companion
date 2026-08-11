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
import { describeImageMessage } from "./vision.js";
import { synthesizeSpeech, synthesizeSpeechFile, EMOTION_WHITELIST } from "./tts.js";
import { sendVoiceWithMeta, sendAudioFile, notifyStart } from "./send-voice.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GATEWAY_URL = process.env.GATEWAY_URL || "http://127.0.0.1:8080";
const GATEWAY_MODEL = process.env.GATEWAY_MODEL || "deepseek-v4-flash";
const TOKEN_PATH = process.env.TOKEN_PATH || path.join(__dirname, "credentials.json");
// 记忆作用域：默认 shared（微信与 LobeHub 共享同一份记忆）；
// 设 BRIDGE_USER_MODE=per-user 后按微信用户隔离；BRIDGE_AGENT_ID 按角色隔离
const BRIDGE_USER_MODE = process.env.BRIDGE_USER_MODE || "shared";
const BRIDGE_AGENT_ID = process.env.BRIDGE_AGENT_ID || "";
// voice = 原生语音条（受微信服务端限制，普通账号可能不显示）；file = MP3 文件附件（临时方案）
const VOICE_MODE = process.env.VOICE_MODE || "voice";
const HISTORY_LIMIT = 10; // 每用户保留的对话轮数
const TYPING_INTERVAL_MS = 3000; // 模拟持续「正在输入」
const REPLY_PART_DELAY_MS = 1200; // 回复分包发送间隔
const REPLY_MAX_PARTS = 3; // 回复最多拆几条
const REPLY_MAX_PART_LENGTH = 42; // 每段最大字数
const DEBOUNCE_MS = parseInt(process.env.MESSAGE_DEBOUNCE_MS ?? "3500", 10); // 消息聚合等待
const USERS_FILE = path.join(__dirname, "known-users.json");
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT ?? "9090", 10);
const EMPTY_REPLY_FALLBACK = "我刚才走神了，再说一遍好吗";

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

/** 记忆作用域：请求携带的身份（未设置时网关使用默认空间，与 LobeHub 共享） */
function scopeFor(userId) {
  const scope = {};
  if (BRIDGE_USER_MODE === "per-user" && userId) {
    scope.user_id = userId;
  }
  if (BRIDGE_AGENT_ID) {
    scope.agent_id = BRIDGE_AGENT_ID;
  }
  return scope;
}

/** 调用记忆网关生成回复（人格 + 记忆由网关注入） */
async function askGateway(messages, { wechatStyle = false, voiceStyle = false, userId } = {}) {
  const resp = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GATEWAY_MODEL,
      stream: false,
      messages,
      ...(wechatStyle ? { wechat_style: true } : {}),
      ...(voiceStyle ? { voice_style: true } : {}),
      ...scopeFor(userId),
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
  const wantVoice = items.some((m) => m.type === "voice");

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
  let usedEmptyFallback = false;
  try {
    console.log("[bridge] 调用网关...");
    reply = await keepTyping(bot, userId, () =>
      askGateway(messages, { wechatStyle: true, voiceStyle: wantVoice, userId }),
    );
    if (!reply || !reply.trim()) {
      console.warn("[bridge] 网关返回空内容，自动重试一次");
      reply = await keepTyping(bot, userId, () =>
        askGateway(messages, { wechatStyle: true, voiceStyle: wantVoice, userId }),
      );
      if (!reply || !reply.trim()) {
        console.warn("[bridge] 重试仍为空，使用兜底回复");
        reply = EMPTY_REPLY_FALLBACK;
        usedEmptyFallback = true;
      }
    }
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

  const replyTarget = items[items.length - 1]; // 用最新一条消息的 context_token
  // 兜底话术直接发文字：保证用户一定看得到（语音条目前受微信服务端限制可能不显示）
  if (wantVoice && !usedEmptyFallback) {
    await sendVoiceReply(bot, replyTarget, reply);
  } else {
    // 拟人化分包发送：拆成 2~3 条短消息，失败自动降级为合并发送
    const parts = splitMessage(reply, REPLY_MAX_PART_LENGTH, REPLY_MAX_PARTS);
    console.log(`[bridge] 分包 ${parts.length} 条，开始发送`);
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
  }
  console.log("[bridge] 发送完成");
  console.log(
    `[bridge] ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} ${userId}: ${combined.slice(0, 40)} → ${reply.length} 字`,
  );
}

/** 解析语音回复：提取 <emotion> 标签并清理朗读文本 */
function parseVoiceReply(text) {
  const match = text.match(/<emotion>\s*([a-z]+)\s*<\/emotion>/i);
  let emotion = match ? match[1].toLowerCase() : "none";
  if (!EMOTION_WHITELIST.has(emotion)) emotion = "";
  const clean = text
    .replace(/<emotion>\s*[a-z]+\s*<\/emotion>/gi, "")
    .replace(/[*_#`>]/g, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // 情绪克制：标签必须与文本中的情绪词匹配才生效，否则按无情绪处理
  const emotionKeywords = {
    happy: ["开心", "高兴", "太棒", "超棒", "好耶", "哇", "哈哈", "嘻嘻", "耶"],
    sad: ["难过", "伤心", "委屈", "呜呜", "哭了", "好累", "唉"],
    angry: ["生气", "讨厌", "气死", "可恶", "哼"],
  };
  if (emotion && !emotionKeywords[emotion].some((k) => clean.includes(k))) {
    emotion = "";
  }
  return { emotion, text: clean.slice(0, 80) };
}

/** 语音回复：豆包 TTS → silk → 微信语音；失败降级为文字 */
async function sendVoiceReply(bot, replyTarget, reply) {
  const { emotion, text } = parseVoiceReply(reply);
  if (!text) {
    console.warn("[bridge] 语音回复文本为空，跳过");
    return;
  }
  try {
    console.log(
      `[bridge] 合成语音（${VOICE_MODE === "file" ? "MP3 文件" : "语音条"}，情绪: ${emotion || "无"}）: ${text.slice(0, 30)}...`,
    );
    if (VOICE_MODE === "file") {
      const { mp3 } = await synthesizeSpeechFile(text, emotion);
      await sendAudioFile(bot, {
        userId: replyTarget.userId,
        contextToken: replyTarget._contextToken,
        audio: mp3,
      });
      console.log(`[bridge] 语音文件已发送（${Math.round(mp3.length / 1024)} KB）`);
    } else {
      const { silk, durationMs } = await synthesizeSpeech(text, emotion);
      await sendVoiceWithMeta(bot, {
        userId: replyTarget.userId,
        contextToken: replyTarget._contextToken,
        silk,
        durationMs,
      });
      console.log(`[bridge] 语音已发送（${Math.round(durationMs / 1000)} 秒）`);
    }
  } catch (err) {
    console.error(`[bridge] 语音合成/发送失败，降级为文字: ${err.message}`);
    try {
      await bot.reply(replyTarget, text);
    } catch (fallbackErr) {
      console.error(`[bridge] 降级文字发送失败: ${fallbackErr.message}`);
    }
  }
}

function enqueueMessage(bot, msg) {
  const userId = msg.userId;
  knownUsers.set(userId, { lastActive: Date.now() });
  saveKnownUsers();

  // 图片消息：异步解析（下载 + 解密 + 视觉转述），完成后以文本消息入队
  if (msg.type === "image") {
    enqueueImage(bot, msg);
    return;
  }

  let entry = pendingMessages.get(userId);
  if (!entry) {
    entry = { items: [], timer: null, waitingImages: 0 };
    pendingMessages.set(userId, entry);
  }
  if (msg.type === "voice") {
    // 语音消息自带转文字（msg.text），直接当作文本入队，并标记需要语音回复
    msg.text = (msg.text || "").trim() || "（语音消息，内容暂不可见）";
  }
  entry.items.push(msg);
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => flushEntry(bot, userId, entry), DEBOUNCE_MS);
}

async function enqueueImage(bot, msg) {
  const userId = msg.userId;
  let entry = pendingMessages.get(userId);
  if (!entry) {
    entry = { items: [], timer: null, waitingImages: 0 };
    pendingMessages.set(userId, entry);
  }
  entry.waitingImages += 1;
  if (entry.timer) clearTimeout(entry.timer);

  let text;
  try {
    console.log("[bridge] 收到图片，开始解析...");
    const desc = await describeImageMessage(msg);
    text = `（用户发来一张图片：${desc}）`;
    console.log(`[bridge] 图片解析完成: ${desc.slice(0, 40)}`);
  } catch (err) {
    console.error(`[bridge] 图片解析失败: ${err.message} | raw=${JSON.stringify(msg.raw ?? null).slice(0, 2000)}`);
    text = "（用户发来一张图片，内容暂不可见）";
  }

  entry.waitingImages -= 1;
  const virtualMsg = { ...msg, type: "text", text };
  enqueueMessage(bot, virtualMsg);
}

function flushEntry(bot, userId, entry) {
  if (entry.waitingImages > 0) {
    // 还有图片在解析，稍等再处理，保证图片与后续文字合并
    entry.timer = setTimeout(() => flushEntry(bot, userId, entry), 500);
    return;
  }
  pendingMessages.delete(userId);
  handleMessage(bot, userId, entry.items).catch((err) =>
    console.error(`[bridge] 处理消息失败: ${err}`),
  );
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
  try {
    const ns = await notifyStart(bot);
    console.log(`[bridge] notifyStart 完成: ${JSON.stringify(ns).slice(0, 200)}`);
  } catch (err) {
    console.warn(`[bridge] notifyStart 失败（忽略）: ${err.message}`);
  }

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
