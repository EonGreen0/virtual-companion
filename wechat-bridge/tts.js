/**
 * 豆包 TTS 2.0 语音合成 + silk 编码（微信语音）
 *
 * 设计要点：
 * - 音色固定（TTS_SPEAKER，默认 vivi 2.0），绝不随机变化
 * - 情绪白名单：happy / sad / angry，且只在明确标记时使用（克制）
 * - 输出 PCM → silk-wasm 编码 → 微信语音
 */

import { randomUUID } from "node:crypto";
import { encode } from "silk-wasm";

const DOUBAO_API_KEY = process.env.DOUBAO_API_KEY;
const TTS_BASE_URL = "https://openspeech.bytedance.com";
const TTS_RESOURCE_ID = process.env.TTS_RESOURCE_ID || "seed-tts-2.0";
export const TTS_SPEAKER = process.env.TTS_SPEAKER || "zh_female_vv_uranus_bigtts";

export const EMOTION_WHITELIST = new Set(["happy", "sad", "angry"]);

/**
 * 请求豆包 TTS，返回原始音频字节。
 * @param {string} text 朗读文本
 * @param {string} emotion happy / sad / angry（白名单外忽略）
 * @param {"pcm"|"mp3"} format 输出格式
 * @param {number} [sampleRate] 采样率（mp3 可省略）
 */
async function requestTTS(text, emotion, format, sampleRate) {
  if (!DOUBAO_API_KEY) {
    throw new Error("未配置 DOUBAO_API_KEY（豆包语音控制台 APIKey）");
  }
  const audioParams = { format };
  if (sampleRate) {
    audioParams.sample_rate = sampleRate;
  }
  if (emotion && EMOTION_WHITELIST.has(emotion)) {
    audioParams.emotion = emotion;
  }

  const body = {
    user: { uid: "virtual-companion" },
    req_params: {
      text,
      speaker: TTS_SPEAKER,
      audio_params: audioParams,
      additions: '{"disable_markdown_filter":true}',
    },
  };

  const resp = await fetch(`${TTS_BASE_URL}/api/v3/tts/unidirectional`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": DOUBAO_API_KEY,
      "X-Api-Connect-Id": randomUUID().replace(/-/g, ""),
      "X-Api-Resource-Id": TTS_RESOURCE_ID,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    throw new Error(`TTS HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }

  const raw = await resp.text();
  const chunks = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    const code = obj.code ?? 0;
    if (code !== 0 && code !== 20000000) {
      throw new Error(`TTS 错误 ${code}: ${obj.message ?? ""}`);
    }
    if (obj.data) {
      const b = Buffer.from(obj.data, "base64");
      if (b.length) chunks.push(b);
    }
    if (obj.done || code === 20000000) {
      break;
    }
  }
  const audio = Buffer.concat(chunks);
  if (audio.length === 0) {
    throw new Error("TTS 未返回音频数据");
  }
  return audio;
}

/**
 * 合成语音并编码为 silk（微信原生语音条）。
 * @param {string} text 朗读文本
 * @param {string} [emotion] happy / sad / angry（白名单外忽略）
 * @returns {{silk: Buffer, durationMs: number}}
 */
export async function synthesizeSpeech(text, emotion = "") {
  // 用 PCM（而非 WAV）：豆包流式 WAV 头不标准，PCM 可直接交给 silk-wasm
  // 采样率固定 16000：与微信端实际收到的语音字段一致（sample_rate=16000）
  const PCM_SAMPLE_RATE = 16000;
  const pcm = await requestTTS(text, emotion, "pcm", PCM_SAMPLE_RATE);

  const encoded = await encode(new Uint8Array(pcm), PCM_SAMPLE_RATE);
  return { silk: Buffer.from(encoded.data), durationMs: encoded.duration };
}

/**
 * 合成 MP3 音频（临时方案：微信语音条受限时，以文件附件发送）。
 * @param {string} text 朗读文本
 * @param {string} [emotion] happy / sad / angry（白名单外忽略）
 * @returns {{mp3: Buffer}}
 */
export async function synthesizeSpeechFile(text, emotion = "") {
  const mp3 = await requestTTS(text, emotion, "mp3", 24000);
  return { mp3 };
}
