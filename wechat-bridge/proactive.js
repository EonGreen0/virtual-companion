/**
 * 主动消息调度器
 *
 * 策略：
 * - 每天在配置的时间窗口内随机选一个时刻触发（不固定准点）
 * - 内容由记忆网关生成（自动注入人格 + 检索记忆），并支持「根据记忆推动」：
 *   指示模型自然地提起共同经历/约定（「我突然想起来…」「上次你说…」）
 * - 主动消息不触发记忆提取（skip_extract），避免内部指令污染记忆
 * - 发送时先显示「正在输入」，长消息拆成 2~3 条短消息连发
 * - 失败（context_token 过期 / 频率限制）自动跳过或退避重试一次
 *
 * 配置（环境变量，均可自由设置）：
 *   PROACTIVE_ENABLED   默认 true
 *   PROACTIVE_WINDOWS   默认 "09:00-11:00,15:00-17:00,20:00-22:00"（逗号分隔）
 *   PROACTIVE_MAX_DAILY 默认 3
 *   PROACTIVE_COOLDOWN_MINUTES 默认 30（最近聊过天后多久内不主动打扰）
 */

import { setTimeout as delay } from "node:timers/promises";

const CONFIG = {
  enabled: (process.env.PROACTIVE_ENABLED ?? "true") === "true",
  windows: (process.env.PROACTIVE_WINDOWS ?? "09:00-11:00,15:00-17:00,20:00-22:00")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  maxPerDay: parseInt(process.env.PROACTIVE_MAX_DAILY ?? "3", 10),
  cooldownMinutes: parseInt(process.env.PROACTIVE_COOLDOWN_MINUTES ?? "30", 10),
  gatewayUrl: process.env.GATEWAY_URL || "http://127.0.0.1:8080",
  model: process.env.GATEWAY_MODEL || "deepseek-v4-flash",
  userMode: process.env.BRIDGE_USER_MODE || "shared",
  agentId: process.env.BRIDGE_AGENT_ID || "",
  maxPartLength: 42,
  maxParts: 3,
  partDelayMs: 1200,
};

function parseTime(text) {
  const [h, m] = text.split(":").map((n) => parseInt(n, 10));
  return h * 60 + (m || 0);
}

function parseWindow(text) {
  const [start, end] = text.split("-").map(parseTime);
  return { start, end };
}

function minutesToDate(minutes) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(minutes / 60), minutes % 60, 0);
}

function randomMinutesBetween(start, end) {
  return start + Math.floor(Math.random() * (end - start));
}

export function splitMessage(text, maxPartLength = CONFIG.maxPartLength, maxParts = CONFIG.maxParts) {
  const sentences = text.match(/[^。！？!?~\n]+[。！？!?~]?/g) || [text];
  const parts = [];
  let current = "";
  for (const s of sentences) {
    const candidate = current + s;
    if (current && candidate.length > maxPartLength) {
      parts.push(current.trim());
      current = s;
    } else {
      current = candidate;
    }
    if (parts.length >= maxParts - 1) break;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.slice(0, maxParts);
}

function formatLastActive(lastActiveMs) {
  if (!lastActiveMs) return "你们还没有聊过";
  const hours = Math.floor((Date.now() - lastActiveMs) / 3_600_000);
  if (hours < 1) return "不久之前";
  if (hours < 24) return `约 ${hours} 小时前`;
  return `约 ${Math.floor(hours / 24)} 天前`;
}

export class ProactiveScheduler {
  constructor(bot, { getUsers }) {
    this.bot = bot;
    this.getUsers = getUsers;
    this.timer = null;
    this.sentToday = 0;
    this.todayKey = "";
    this.nextFireAt = null;
  }

  async start() {
    if (!CONFIG.enabled) {
      console.log("[proactive] 已禁用（PROACTIVE_ENABLED=false）");
      return;
    }
    await this.#scheduleNext();
  }

  async #scheduleNext() {
    if (this.timer) clearTimeout(this.timer);
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const candidates = CONFIG.windows
      .map(parseWindow)
      .filter((w) => w.end > nowMinutes)
      .map((w) => randomMinutesBetween(Math.max(w.start, nowMinutes + 1), w.end));
    if (candidates.length === 0) {
      console.log("[proactive] 今日窗口已过，等待明天");
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 5, 0);
      this.timer = setTimeout(() => this.#scheduleNext(), tomorrow - now);
      return;
    }
    const nextMinutes = Math.min(...candidates);
    const fireAt = minutesToDate(nextMinutes);
    this.nextFireAt = fireAt;
    const waitMs = Math.max(10_000, fireAt - now);
    console.log(`[proactive] 下次主动消息: ${fireAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}（${Math.round(waitMs / 60000)} 分钟后）`);
    this.timer = setTimeout(() => this.#fire(), waitMs);
  }

  async #fire() {
    const todayKey = new Date().toDateString();
    if (todayKey !== this.todayKey) {
      this.todayKey = todayKey;
      this.sentToday = 0;
    }
    if (this.sentToday >= CONFIG.maxPerDay) {
      console.log(`[proactive] 今日已达上限 ${CONFIG.maxPerDay} 条，跳过`);
      await this.#scheduleNext();
      return;
    }

    const target = this.#pickTargetUser();
    if (!target) {
      console.log("[proactive] 没有可发送的用户（用户还未给 Bot 发过消息）");
      await this.#scheduleNext();
      return;
    }

    // 冷却期检查：刚聊过天时不主动打扰（避免插话违和）
    const cooldownMs = CONFIG.cooldownMinutes * 60_000;
    const idleMinutes = Math.round((Date.now() - target.lastActive) / 60_000);
    if (Date.now() - target.lastActive < cooldownMs) {
      console.log(`[proactive] 用户 ${idleMinutes} 分钟前还在聊天（冷却期 ${CONFIG.cooldownMinutes} 分钟），本次跳过`);
      await this.#scheduleNext();
      return;
    }

    const ok = await this.#sendOnce(target.userId, target.lastActive);
    if (ok) this.sentToday += 1;
    await this.#scheduleNext();
  }

  #pickTargetUser() {
    const users = this.getUsers();
    if (!users.length) return null;
    return users.sort((a, b) => b.lastActive - a.lastActive)[0];
  }

  async #generateMessage(lastActive, userId) {
    const now = new Date();
    const prompt = [
      `现在时间：${now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}，星期${"日一二三四五六"[now.getDay()]}。`,
      `你们上次聊天是${formatLastActive(lastActive)}。`,
      "现在轮到你主动给用户发一条微信消息。要求：",
      "1. 混合两种内容：一句日常关心/问候 + 一句你自己的小日常分享，自然融合成一条消息",
      "2. 如果上面提供的记忆里有值得提起的共同经历、约定或用户喜好，自然地提一句，可以用「我突然想起来…」「上次你说…」「还记得我们…」这样的口吻；没有值得提的就不要硬提，更不要编造",
      "3. 口语化、短句，30~80 字，像真人发微信一样自然",
      "4. 不要出现「作为AI」「主动消息」「根据记忆」这类字眼",
      "5. 最多问一个问题，不要连续追问",
    ].join("\n");

    const resp = await fetch(`${CONFIG.gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CONFIG.model,
        stream: false,
        skip_extract: true,
        ...(CONFIG.userMode === "per-user" && userId ? { user_id: userId } : {}),
        ...(CONFIG.agentId ? { agent_id: CONFIG.agentId } : {}),
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!resp.ok) throw new Error(`gateway ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error(`[proactive] 网关返回非 JSON: ${text.slice(0, 300)}`);
      return "";
    }
    const content = data.choices?.[0]?.message?.content ?? "";
    if (!content.trim()) {
      console.error(`[proactive] 网关返回空内容: ${text.slice(0, 300)}`);
    }
    return content.trim();
  }

  async #sendOnce(userId, lastActive) {
    let message;
    try {
      message = await this.#generateMessage(lastActive, userId);
    } catch (err) {
      console.error(`[proactive] 生成失败: ${err.message}`);
      return false;
    }
    if (!message) {
      console.error("[proactive] 生成为空");
      return false;
    }

    try {
      await this.bot.sendTyping(userId).catch(() => {});
      const parts = splitMessage(message);
      for (const part of parts) {
        await this.bot.send(userId, part);
        await delay(CONFIG.partDelayMs);
      }
      await this.bot.stopTyping(userId).catch(() => {});
      console.log(`[proactive] 已发送（${parts.length} 条）: ${message.slice(0, 60)}`);
      return true;
    } catch (err) {
      const ret = String(err?.response?.data?.ret ?? err?.response?.status ?? err?.code ?? "");
      console.error(`[proactive] 发送失败: ${err.message}（ret=${ret}）`);
      if (ret === "-2") {
        console.log("[proactive] 频率限制，5 分钟后重试一次");
        await delay(300_000);
        try {
          await this.bot.send(userId, message.slice(0, CONFIG.maxPartLength * CONFIG.maxParts));
          console.log("[proactive] 重试成功");
          return true;
        } catch (retryErr) {
          console.error(`[proactive] 重试仍失败: ${retryErr.message}`);
        }
      }
      return false;
    }
  }

  /** 手动触发一次（npm run poke） */
  async poke() {
    const target = this.#pickTargetUser();
    if (!target) {
      console.log("[proactive] 没有可发送的用户");
      return;
    }
    console.log(`[proactive] 手动触发，发送给最近活跃用户`);
    await this.#sendOnce(target.userId, target.lastActive);
  }

  status() {
    return {
      enabled: CONFIG.enabled,
      windows: CONFIG.windows,
      maxPerDay: CONFIG.maxPerDay,
      cooldownMinutes: CONFIG.cooldownMinutes,
      sentToday: this.sentToday,
      nextFireAt: this.nextFireAt ? this.nextFireAt.toISOString() : null,
      knownUsers: this.getUsers().length,
    };
  }
}
