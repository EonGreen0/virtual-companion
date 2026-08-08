/**
 * 稳健的 iLink 扫码登录（绕过 SDK 的 15 秒轮询超时）
 * 凭证保存为 SDK 兼容格式：credentials.json
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = "https://ilinkai.weixin.qq.com";
const TOKEN_PATH = path.join(__dirname, "credentials.json");
const POLL_INTERVAL_MS = 2000;

async function getQrCode() {
  const resp = await fetch(`${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`, {
    signal: AbortSignal.timeout(30_000),
  });
  const data = await resp.json();
  if (data.ret !== 0) {
    throw new Error(`获取二维码失败: ${JSON.stringify(data)}`);
  }
  return data;
}

async function pollStatus(qrcode) {
  const resp = await fetch(
    `${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: AbortSignal.timeout(120_000),
    },
  );
  return resp.json();
}

const qr = await getQrCode();
console.log(`LOGIN_URL=${qr.qrcode_img_content}`);
console.log("等待扫码确认...");

for (;;) {
  const status = await pollStatus(qr.qrcode);
  if (status.status === "scaned") {
    console.log("已扫码，请在微信中点击确认...");
  }
  if (status.status === "confirmed") {
    if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id) {
      throw new Error(`确认成功但缺少凭证: ${JSON.stringify(status)}`);
    }
    const credentials = {
      token: status.bot_token,
      baseUrl: status.baseurl ?? BASE_URL,
      accountId: status.ilink_bot_id,
      userId: status.ilink_user_id,
    };
    await writeFile(TOKEN_PATH, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    console.log("登录成功，凭证已保存到 credentials.json");
    process.exit(0);
  }
  if (status.status === "expired") {
    console.log("二维码已过期，请重新运行登录脚本");
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
}
