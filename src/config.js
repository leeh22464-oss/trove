import { randomBytes } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

export const DATA_DIR = process.env.CATCH_DATA_DIR || path.join(process.cwd(), 'data');
export const ASSETS_DIR = path.join(DATA_DIR, 'assets');
export const DB_PATH = path.join(DATA_DIR, 'catch.db');

export function ensureDataDirs() {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
}

// 密钥类设置：存库，允许环境变量覆盖，读取接口不回传明文
const SECRET_KEYS = new Set(['llm_api_key', 'paddle_token']);
const ENV_MAP = {
  llm_api_key: 'CATCH_LLM_API_KEY',
  paddle_token: 'CATCH_PADDLE_TOKEN',
};

export const DEFAULTS = {
  llm_base_url: '',
  llm_api_key: '',
  llm_model: '',
  llm_temperature: '0.2',
  llm_timeout_ms: '30000',
  llm_custom_prompt: '',
  auto_clean: '1',
  auto_classify: '1',
  auto_ocr: '1',
  ai_tags_per_item: '5',
  tag_suggest_topk: '30',
  ocr_chain: 'paddle-hosted,paddle-selfhost,vision-llm',
  paddle_base_url: 'https://paddleocr.aistudio-app.com',
  paddle_token: '',
  paddle_model: 'PP-OCRv5',
  paddle_poll_interval_ms: '2000',
  paddle_poll_timeout_ms: '120000',
  paddle_selfhost_url: 'http://localhost:8080',
  obsidian_vault: '',
  capture_token: '',
};

export class Settings {
  constructor(db) {
    this.db = db;
    this.get_ = db.prepare('SELECT value FROM settings WHERE key=?');
    this.set_ = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  }
  get(key) {
    const env = ENV_MAP[key];
    if (env && process.env[env]) return process.env[env];
    const row = this.get_.get(key);
    if (row) return row.value;
    return DEFAULTS[key] ?? '';
  }
  set(key, value) {
    this.set_.run(key, String(value ?? ''));
  }
  setMany(obj) {
    for (const [k, v] of Object.entries(obj)) {
      if (!(k in DEFAULTS)) continue;
      if (SECRET_KEYS.has(k) && String(v ?? '').includes('****')) continue;
      this.set(k, v);
    }
  }
  // 供 API 返回：密钥掩码
  publicView() {
    const out = {};
    for (const k of Object.keys(DEFAULTS)) {
      if (SECRET_KEYS.has(k)) {
        const v = this.get(k);
        out[k] = v ? maskSecret(v) : '';
        out[k + '_set'] = v ? '1' : '0';
      } else if (k === 'capture_token') {
        out[k] = this.get(k);
      } else {
        out[k] = this.get(k);
      }
    }
    return out;
  }
  ensureCaptureToken() {
    let t = this.get('capture_token');
    if (!t) {
      t = 'ct_' + randomBytes(24).toString('hex');
      this.set('capture_token', t);
    }
    return t;
  }
  resetCaptureToken() {
    const t = 'ct_' + randomBytes(24).toString('hex');
    this.set('capture_token', t);
    return t;
  }
}

export function maskSecret(v) {
  if (!v) return '';
  if (v.length <= 8) return '****';
  return v.slice(0, 4) + '****' + v.slice(-4);
}
