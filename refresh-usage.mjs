#!/usr/bin/env node
/**
 * 后台异步刷新 Antigravity CLI 订阅配额（/usage）与积分（/credits）缓存。
 * 使用官方只读命令 `agy -p "/usage" --output-format json` 与 `"/credits"`，
 * 不发起对话回合、不消耗配额，并采用原子写入避免状态栏读到半截文件。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HUD_DIR = path.dirname(new URL(import.meta.url).pathname);
const CACHE_FILE = path.join(HUD_DIR, 'usage-cache.json');
const LOCK_FILE = path.join(HUD_DIR, '.refresh.lock');
const LOCK_STALE_MS = 30_000;

function resolveAgyBin() {
  const candidates = [
    process.env.AGY_BIN,
    path.join(os.homedir(), '.local', 'bin', 'agy'),
    '/opt/homebrew/bin/agy',
    '/usr/local/bin/agy',
    'agy',
  ].filter(Boolean);
  for (const bin of candidates) {
    if (bin === 'agy' || fs.existsSync(bin)) return bin;
  }
  return 'agy';
}

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const stat = fs.statSync(LOCK_FILE);
      if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) {
        return false;
      }
      fs.unlinkSync(LOCK_FILE);
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  } catch {
    // 忽略清理锁文件时的错误
  }
}

async function runAgyJson(bin, slashCmd) {
  const { stdout } = await execFileAsync(bin, ['-p', slashCmd, '--output-format', 'json'], {
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      PATH: `${path.join(os.homedir(), '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
    },
  });
  const parsed = JSON.parse(stdout.trim());
  return parsed?.command?.data ?? null;
}

async function main() {
  if (!acquireLock()) return;
  try {
    const bin = resolveAgyBin();
    const prev = (() => {
      try {
        return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      } catch {
        return {};
      }
    })();

    const [usageRes, creditsRes] = await Promise.allSettled([
      runAgyJson(bin, '/usage'),
      runAgyJson(bin, '/credits'),
    ]);

    let usageData = prev.usage ?? null;
    let creditsData = prev.credits ?? null;
    let lastError = null;

    if (usageRes.status === 'fulfilled' && Array.isArray(usageRes.value?.groups)) {
      usageData = usageRes.value;
    } else if (usageRes.status === 'rejected') {
      lastError = usageRes.reason?.message || 'usage_failed';
    }

    if (creditsRes.status === 'fulfilled' && typeof creditsRes.value?.remaining_credits === 'number') {
      creditsData = creditsRes.value;
    } else if (creditsRes.status === 'rejected') {
      lastError = lastError || creditsRes.reason?.message || 'credits_failed';
    }

    const next = {
      updatedAt: Date.now(),
      usage: usageData,
      credits: creditsData,
      lastError,
    };
    const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next), 'utf8');
    fs.renameSync(tmp, CACHE_FILE);
  } finally {
    releaseLock();
  }
}

main();
