/**
 * 发送微信语音消息（自研，修正 SDK 缺失的元数据 + 语音 CDN 怪癖）
 *
 * 关键修正（对照腾讯官方 iLink 协议与 weixin-gateway 实测实现）：
 * 1. voice_item.encode_type 必须为 4：实测微信端下发的语音 encode_type=4（silk），
 *    官方注释里的 6 与真实协议不一致，之前误用 1/6 都不显示
 * 2. playtime 单位为毫秒，之前误用秒
 * 3. sample_rate 必须为 16000：实测微信端下发的语音 sample_rate=16000，
 *    与豆包 PCM → silk 编码参数一致（16kHz/16bit）
 * 4. 语音上传的下载 token 用 getuploadurl 返回的 upload_param
 *    （2026-03 起 CDN 对 VOICE 不再下发 x-encrypted-query-param，用 upload_param
 *     作为 encrypt_query_param 是 weixin-gateway 实测确认的怪癖）
 */

import { randomBytes, randomUUID, createCipheriv, createHash } from "node:crypto";

const CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";

// 官方 openclaw-weixin 客户端身份（媒体发送能力由这些头/版本决定）
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6); // 2.4.6 → 132102
const CHANNEL_VERSION = "2.4.6";
const BOT_AGENT = "OpenClaw";

function randomWechatUin() {
  const value = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf8").toString("base64");
}

async function apiFetch(baseUrl, endpoint, body, token, timeoutMs = 30_000) {
  const resp = await fetch(`${baseUrl.replace(/\/+$/, "")}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      Authorization: `Bearer ${token}`,
      "X-WECHAT-UIN": randomWechatUin(),
      "iLink-App-Id": ILINK_APP_ID,
      "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const rawBody = await resp.text();
  if (!resp.ok) {
    throw new Error(`${endpoint} HTTP ${resp.status}: ${rawBody.slice(0, 300)}`);
  }
  let data;
  try {
    data = JSON.parse(rawBody);
  } catch {
    throw new Error(`${endpoint} 非 JSON 响应: ${rawBody.slice(0, 300)}`);
  }
  if (data.ret !== undefined && data.ret !== 0) {
    throw new Error(`${endpoint} ret=${data.ret} ${data.errmsg ?? ""} ${rawBody.slice(0, 300)}`);
  }
  return data;
}

/** 媒体专用上传：加密文件 → CDN 上传 → 返回下载凭证与 AES 密钥 */
async function uploadVoiceToCdn(bot, toUserId, silk, mediaType = 4) {
  const credentials = await bot.ensureCredentials();
  const rawsize = silk.length;
  const rawfilemd5 = createHash("md5").update(silk).digest("hex");
  const filesize = Math.ceil((rawsize + 1) / 16) * 16; // AES-128-ECB PKCS7 填充后大小
  const filekey = randomBytes(16).toString("hex");
  const aeskey = randomBytes(16);

  const uploadUrlResp = await apiFetch(
    bot.baseUrl,
    "/ilink/bot/getuploadurl",
    {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskey.toString("hex"),
      base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT },
    },
    credentials.token,
    15_000,
  );

  const uploadFullUrl = uploadUrlResp.upload_full_url?.trim();
  if (!uploadFullUrl) {
    throw new Error(`getuploadurl 未返回上传地址: ${JSON.stringify(uploadUrlResp).slice(0, 400)}`);
  }

  let uploadParam = uploadUrlResp.upload_param;
  // 服务器可能只回 upload_full_url，其中带着同样的 encrypted_query_param 参数，
  // 从 URL 里提取出来即可（CDN 上传地址格式与本地 buildCdnUploadUrl 一致）。
  if (!uploadParam && uploadFullUrl) {
    try {
      const u = new URL(uploadFullUrl);
      uploadParam = u.searchParams.get("encrypted_query_param") || u.searchParams.get("upload_param");
    } catch {
      /* URL 解析失败则留空，走 CDN 头兜底 */
    }
  }

  const cipher = createCipheriv("aes-128-ecb", aeskey, null);
  const ciphertext = Buffer.concat([cipher.update(silk), cipher.final()]);

  let cdnUrl = uploadFullUrl;
  if (!cdnUrl) {
    cdnUrl = `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
  }
  const cdnResp = await fetch(cdnUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: ciphertext,
    signal: AbortSignal.timeout(120_000),
  });
  const cdnBody = await cdnResp.text();
  if (!cdnResp.ok) {
    throw new Error(`CDN 上传失败: ${cdnResp.status} ${cdnBody.slice(0, 300)}`);
  }

  return {
    uploadParam,
    queryParam: cdnResp.headers.get("x-encrypted-query-param"),
    shortParam: cdnResp.headers.get("x-encrypted-param"),
    aeskey: aeskey.toString("hex"),
    fileSizeCiphertext: filesize,
  };
}

export async function postSendMessage(baseUrl, token, msg) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`,
    "X-WECHAT-UIN": randomWechatUin(),
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
  };
  const resp = await fetch(`${baseUrl.replace(/\/+$/, "")}/ilink/bot/sendmessage`, {
    method: "POST",
    headers,
    body: JSON.stringify({ msg, base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    throw new Error(`sendmessage HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  const rawBody = await resp.text();
  let data;
  try {
    data = JSON.parse(rawBody);
  } catch {
    throw new Error(`sendmessage 非 JSON 响应: ${rawBody.slice(0, 300)}`);
  }
  // 成功响应形如 {"message_id": ...}；失败才带 ret/errcode
  if (data.message_id) {
    return data;
  }
  if (data.ret !== undefined && data.ret !== 0) {
    throw new Error(`sendmessage ret=${data.ret} ${JSON.stringify(data).slice(0, 400)}`);
  }
  throw new Error(`sendmessage 响应异常: ${rawBody.slice(0, 500)}`);
}

/** 通知服务器：bot 已启动（官方插件启动流程的必需步骤，媒体发送依赖） */
export async function notifyStart(bot) {
  const credentials = await bot.ensureCredentials();
  return apiFetch(
    bot.baseUrl,
    "/ilink/bot/msg/notifystart",
    { base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT } },
    credentials.token,
    15_000,
  );
}

/** 通知服务器：bot 正在停止 */
export async function notifyStop(bot) {
  const credentials = await bot.ensureCredentials();
  return apiFetch(
    bot.baseUrl,
    "/ilink/bot/msg/notifystop",
    { base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT } },
    credentials.token,
    15_000,
  );
}

/**
 * 发送一条微信语音消息。
 * @param {import("@chnak/weixin-bot").WeixinBot} bot
 * @param {object} opts
 * @param {string} opts.userId 目标用户
 * @param {string} opts.contextToken 会话令牌
 * @param {Buffer} opts.silk silk 音频
 * @param {number} opts.durationMs 音频时长（毫秒）
 */
export async function sendVoiceWithMeta(bot, { userId, contextToken, silk, durationMs }) {
  const credentials = await bot.ensureCredentials();
  const uploaded = await uploadVoiceToCdn(bot, userId, silk);

  // 下载 token 优先级：先试图片同款的 x-encrypted-param（shortParam），
  // 再退回 getuploadurl 的 upload_param → x-encrypted-query-param。
  const downloadToken = uploaded.shortParam || uploaded.uploadParam || uploaded.queryParam;
  if (!downloadToken) {
    throw new Error("语音上传未返回任何下载 token");
  }

  const voiceItem = {
    media: {
      encrypt_query_param: downloadToken,
      aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
      encrypt_type: 1,
    },
    encode_type: 4, // 实测微信语音的 encode_type=4
    bits_per_sample: 16,
    sample_rate: 16000,
    playtime: Math.max(1, Math.round(durationMs)),
    mid_size: uploaded.fileSizeCiphertext,
  };

  console.log(
    `[send-voice] silk=${silk.length}B playtime=${voiceItem.playtime}ms ` +
      `encode_type=${voiceItem.encode_type} sample_rate=${voiceItem.sample_rate} ` +
      `downloadToken=${downloadToken.length}chars(${uploaded.shortParam ? "shortParam" : uploaded.uploadParam ? "uploadParam" : "queryParam"}) ` +
      `uploadParam=${uploaded.uploadParam?.length ?? 0}chars ` +
      `queryParam=${uploaded.queryParam?.length ?? 0}chars ` +
      `shortParam=${uploaded.shortParam?.length ?? 0}chars`,
  );

  await postSendMessage(bot.baseUrl, credentials.token, {
    from_user_id: "",
    to_user_id: userId,
    client_id: randomUUID(),
    message_type: 2, // BOT
    message_state: 2, // FINISH
    context_token: contextToken,
    item_list: [{ type: 3, voice_item: voiceItem }], // VOICE
  });
}

/**
 * 以文件附件发送音频（临时方案：VOICE_MODE=file）。
 * 微信文件链路确认可用，可点开播放，但不是原生语音气泡。
 * @param {import("@chnak/weixin-bot").WeixinBot} bot
 * @param {object} opts
 * @param {string} opts.userId 目标用户
 * @param {string} opts.contextToken 会话令牌
 * @param {Buffer} opts.audio MP3 音频
 * @param {string} [opts.fileName] 文件名（默认 voice.mp3）
 */
export async function sendAudioFile(
  bot,
  { userId, contextToken, audio, fileName = "voice.mp3" },
) {
  const credentials = await bot.ensureCredentials();
  const uploaded = await uploadVoiceToCdn(bot, userId, audio, 3); // FILE
  const downloadToken = uploaded.shortParam || uploaded.uploadParam || uploaded.queryParam;
  if (!downloadToken) {
    throw new Error("文件上传未返回下载 token");
  }

  await postSendMessage(bot.baseUrl, credentials.token, {
    from_user_id: "",
    to_user_id: userId,
    client_id: randomUUID(),
    message_type: 2, // BOT
    message_state: 2, // FINISH
    context_token: contextToken,
    item_list: [
      {
        type: 4, // FILE
        file_item: {
          media: {
            encrypt_query_param: downloadToken,
            aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
            encrypt_type: 1,
          },
          file_name: fileName,
          len: String(audio.length),
        },
      },
    ],
  });
}
