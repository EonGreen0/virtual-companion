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
import { WeixinBot } from "@chnak/weixin-bot";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GATEWAY_URL = process.env.GATEWAY_URL || "http://127.0.0.1:8080";
const GATEWAY_MODEL = process.env.GATEWAY_MODEL || "deepseek-v4-flash";
const TOKEN_PATH = process.env.TOKEN_PATH || path.join(__dirname, "credentials.json");
const HISTORY_LIMIT = 10; // 每用户保留的对话轮数
const TYPING_INTERVAL_MS = 3000; // 模拟持续「正在输入」

/** 每用户的对话历史：userId -> [{role, content}] */
const history = new Map();

/** 调用记忆网关生成回复（人格 + 记忆由网关注入） */
async function askGateway(messages) {
  const resp = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GATEWAY_MODEL,
      stream: false,
      messages,
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

async function handleMessage(bot, msg) {
  const text = (msg.text || "").trim();
  if (!text) {
    return;
  }

  const prev = history.get(msg.userId) || [];
  const messages = [
    ...prev.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: text },
  ];

  let reply;
  try {
    reply = await keepTyping(bot, msg.userId, () => askGateway(messages));
  } catch (err) {
    console.error(`[bridge] 网关调用失败: ${err.message}`);
    reply = "唔……我刚才走神了一下，你能再说一遍吗？";
  }

  // 更新会话历史
  prev.push({ role: "user", content: text }, { role: "assistant", content: reply });
  if (prev.length > HISTORY_LIMIT * 2) {
    prev.splice(0, prev.length - HISTORY_LIMIT * 2);
  }
  history.set(msg.userId, prev);

  await bot.reply(msg, reply);
  console.log(
    `[bridge] ${msg.timestamp?.toLocaleTimeString?.() ?? ""} ${msg.userId}: ${text.slice(0, 40)} → ${reply.length} 字`,
  );
}

async function main() {
  const forceLogin = process.argv.includes("--login");
  const loginOnly = process.argv.includes("--login-only") || forceLogin;
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
    handleMessage(bot, msg).catch((err) => console.error(`[bridge] 处理消息失败: ${err}`));
  });

  await bot.run();
}

main().catch((err) => {
  console.error("[bridge] 启动失败:", err);
  process.exit(1);
});
