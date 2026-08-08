/**
 * 微信图片理解：下载 → AES 解密 → 豆包视觉转述
 *
 * iLink 收到的图片是 CDN 上的 AES-128-ECB 密文，需要：
 * 1. 从消息 raw 中取图片 URL 与 aes_key
 * 2. 下载密文并用 aes_key 解密
 * 3. 转 base64 调用火山方舟豆包视觉模型（OpenAI 兼容接口）
 * 4. 返回图片的文字描述
 */

import { createDecipheriv } from "node:crypto";

function decryptAesEcb(ciphertext, key) {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

const VISION_API_URL = "https://ark.cn-beijing.volces.com/api/v3/chat/completions";
const VISION_MODEL = process.env.VISION_MODEL || "doubao-seed-2-0-mini-260215";

const DESCRIBE_PROMPT =
  "请客观描述这张图片：主体是什么、颜色、场景、画面里的文字（如有）。只用 30~80 字，不要评价、不要建议、不要寒暄、不要猜测。";

async function downloadImage(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) {
    throw new Error(`图片下载失败 HTTP ${resp.status}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

async function describeWithDoubao(imageBase64, contentType) {
  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) {
    throw new Error("未配置 ARK_API_KEY");
  }
  const resp = await fetch(VISION_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: DESCRIBE_PROMPT },
            {
              type: "image_url",
              image_url: { url: `data:${contentType};base64,${imageBase64}` },
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    throw new Error(`视觉 API HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const data = await resp.json();
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

function guessContentType(imageItem) {
  const format = imageItem?.format;
  if (format) return `image/${format}`;
  const mime = imageItem?.mime_type || imageItem?.mime;
  if (mime) return mime;
  return "image/jpeg";
}

/**
 * 解析一条微信图片消息，返回文字描述。
 * @param {object} msg SDK IncomingMessage（含 raw）
 */
export async function describeImageMessage(msg) {
  // full_url 等字段是收到消息后异步生成的，轮询等待其就绪
  let raw = null;
  let imageItem = null;
  for (let i = 0; i < 50; i++) {
    raw = JSON.parse(JSON.stringify(msg.raw ?? null));
    imageItem = raw?.item_list?.[0]?.image_item;
    if (imageItem?.full_url || imageItem?.url) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const url =
    imageItem?.full_url ||
    imageItem?.url ||
    (typeof msg.text === "string" && msg.text.startsWith("http") ? msg.text : null);
  if (!url || typeof url !== "string" || (!url.startsWith("http") && !url.startsWith("//"))) {
    throw new Error("消息中没有图片 URL");
  }
  const fullUrl = url.startsWith("//") ? `https:${url}` : url;

  const cipher = await downloadImage(fullUrl);
  let plain = cipher;
  if (imageItem?.aes_key) {
    const key = Buffer.from(imageItem.aes_key, "base64");
    plain = decryptAesEcb(cipher, key);
  }

  const base64 = plain.toString("base64");
  const contentType = guessContentType(imageItem);
  const description = await describeWithDoubao(base64, contentType);
  return description || "（图片内容未能识别）";
}
