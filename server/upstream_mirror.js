/**
 * 线上兜底 (upstream mirror)：本机网络拦截了 Coinbase 等官方接口时，
 * 改从已部署的线上网页端读取同一份数据 (线上直连 Coinbase 拿到的结果)。
 *
 * 线上网址的配置 (任选其一，环境变量优先)：
 *   - 环境变量 UPSTREAM_ORIGIN=https://xxx.onrender.com
 *   - 仓库根目录 upstream.local.json: { "origin": "https://xxx.onrender.com" } (已在 .gitignore)
 * 未配置时整个模块静默不生效；线上部署本身不配置，因此不会互相转发。
 */

const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('./http_client');

const CONFIG_FILE = path.join(__dirname, '..', 'upstream.local.json');
const RESPONSE_TTL_MS = 60e3;     // 同一路径 1 分钟内复用，避免一次刷新里重复请求
const FAILURE_COOLDOWN_MS = 5 * 60e3; // 线上不可达时 5 分钟内不再尝试
const TIMEOUT_MS = 60e3;          // Render 免费实例冷启动可能要几十秒

const responses = new Map(); // path → { at, data }
const inflight = new Map();
let failedUntil = 0;
let lastError = null;

/** 读取线上网址；无效或未配置返回 null */
function getUpstreamOrigin() {
  let raw = process.env.UPSTREAM_ORIGIN || null;
  if (!raw) {
    try {
      raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).origin || null;
    } catch (e) {
      raw = null;
    }
  }
  if (!raw) return null;
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    // 指向本机自身会形成转发回环
    const ownPort = String(process.env.PORT || 3000);
    if (['localhost', '127.0.0.1', '::1'].includes(u.hostname) && (u.port || (u.protocol === 'https:' ? '443' : '80')) === ownPort) return null;
    return u.origin;
  } catch (e) {
    return null;
  }
}

/**
 * GET 线上 API (如 '/api/coinbase-liquidity')，返回解析后的 JSON (要求 code === 0)。
 * 未配置 / 冷却中 / 失败时抛错，调用方按普通数据源失败处理。
 */
async function fetchUpstreamJson(pathAndQuery) {
  const origin = getUpstreamOrigin();
  if (!origin) throw new Error('未配置线上网址 (UPSTREAM_ORIGIN 或 upstream.local.json)');
  if (Date.now() < failedUntil) throw new Error(`线上暂不可达，${Math.ceil((failedUntil - Date.now()) / 60e3)} 分钟后重试 (${lastError})`);
  const hit = responses.get(pathAndQuery);
  if (hit && Date.now() - hit.at < RESPONSE_TTL_MS) return hit.data;
  if (inflight.has(pathAndQuery)) return inflight.get(pathAndQuery);

  const task = (async () => {
    try {
      const res = await fetchWithTimeout(origin + pathAndQuery, {
        timeout: TIMEOUT_MS,
        retries: 0,
        headers: { Accept: 'application/json', 'X-Bigdy-Mirror': '1' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data || data.code !== 0) throw new Error(`线上返回 code=${data && data.code}`);
      responses.set(pathAndQuery, { at: Date.now(), data });
      return data;
    } catch (e) {
      failedUntil = Date.now() + FAILURE_COOLDOWN_MS;
      lastError = e.message;
      console.warn(`[UpstreamMirror] ${origin}${pathAndQuery} 失败: ${e.message}`);
      throw e;
    }
  })().finally(() => inflight.delete(pathAndQuery));
  inflight.set(pathAndQuery, task);
  return task;
}

function getUpstreamStatus() {
  return {
    origin: getUpstreamOrigin(),
    coolingDownUntil: failedUntil > Date.now() ? new Date(failedUntil).toISOString() : null,
    lastError
  };
}

/** 测试用：清空缓存与冷却 */
function resetUpstreamMirror() {
  responses.clear();
  inflight.clear();
  failedUntil = 0;
  lastError = null;
}

module.exports = { getUpstreamOrigin, fetchUpstreamJson, getUpstreamStatus, resetUpstreamMirror };
