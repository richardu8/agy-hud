#!/usr/bin/env node
/**
 * Antigravity CLI（agy）实时 HUD 状态栏配件（仿 claude-hud 风格）。
 * 第一行展示模型、上下文占用进度条、本次会话估算花费/Token 与输出速度（tok/s）、子代理与工作区 Git 状态；
 * 第二行展示订阅配额耗用（各模型池 5 小时与每周窗口已用比例、重置倒计时及可用积分）。
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HUD_DIR = path.dirname(new URL(import.meta.url).pathname);
const CACHE_FILE = path.join(HUD_DIR, 'usage-cache.json');
const REFRESH_SCRIPT = path.join(HUD_DIR, 'refresh-usage.mjs');
const LOCK_FILE = path.join(HUD_DIR, '.refresh.lock');
const TRANSCRIPT_CACHE_FILE = path.join(HUD_DIR, 'transcript-cache.json');
const SPEED_CACHE_DIR = path.join(HUD_DIR, 'speed-cache');
const GIT_CACHE_FILE = path.join(HUD_DIR, 'git-cache.json');

const CACHE_TTL_MS = 45_000;      // 配额后台刷新周期：45 秒
const GIT_TTL_MS = 4_000;         // Git 状态缓存：4 秒
const MAX_STEP_DURATION_MS = 600_000; // 单步耗时上限保护：10 分钟
const MAX_PLAUSIBLE_TPS = 2000;   // 异常速度上限保护

// ANSI 颜色（在浅/深终端配色下均可辨识，语义对齐 claude-hud）
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const BRIGHT_BLUE = '\x1b[94m';
const BRIGHT_MAGENTA = '\x1b[95m';

function colorByContext(pct) {
  if (pct >= 85) return RED;
  if (pct >= 70) return YELLOW;
  return GREEN;
}

function colorByQuota(pct) {
  if (pct >= 90) return RED;
  if (pct >= 75) return BRIGHT_MAGENTA;
  return BRIGHT_BLUE;
}

function progressBar(pct, width = 8, colorFn = colorByContext) {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = Math.max(0, width - filled);
  const c = colorFn(clamped);
  return `${c}${'█'.repeat(filled)}${DIM}${'░'.repeat(empty)}${RESET}`;
}

function formatTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    if (m >= 10) return `${Math.round(m)}M`;
    return `${m.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

function formatUsd(usd) {
  if (!Number.isFinite(usd) || usd < 0) return null;
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  if (usd < 10) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(1)}`;
}

function formatSpeed(tps) {
  if (!Number.isFinite(tps) || tps <= 0 || tps > MAX_PLAUSIBLE_TPS) return null;
  return tps >= 100 ? `${Math.round(tps)} tok/s` : `${tps.toFixed(1)} tok/s`;
}

function formatResetCountdown(resetTimeIso, resetInSec) {
  let sec = null;
  if (Number.isFinite(resetInSec)) {
    sec = Math.max(0, Math.round(resetInSec));
  } else if (typeof resetTimeIso === 'string' && resetTimeIso) {
    const targetMs = Date.parse(resetTimeIso);
    if (Number.isFinite(targetMs)) {
      sec = Math.max(0, Math.round((targetMs - Date.now()) / 1000));
    }
  }
  if (sec === null) return '';
  if (sec <= 60) return '将重置';
  const totalMin = Math.round(sec / 60);
  const d = Math.floor(totalMin / (60 * 24));
  const h = Math.floor((totalMin % (60 * 24)) / 60);
  const m = totalMin % 60;
  if (d > 0) return h > 0 ? `${d}d${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
  return `${m}m`;
}

function readJsonSafe(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, obj) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch {
    // 忽略缓存写入错误
  }
}

function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function maybeTriggerUsageRefresh(cache) {
  const age = cache?.updatedAt ? Date.now() - cache.updatedAt : Infinity;
  if (age < CACHE_TTL_MS) return;

  try {
    if (fs.existsSync(LOCK_FILE)) {
      const stat = fs.statSync(LOCK_FILE);
      if (Date.now() - stat.mtimeMs < 30_000) return;
    }
  } catch {
    // 继续尝试刷新
  }

  try {
    const child = spawn(process.execPath, [REFRESH_SCRIPT], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // 不阻塞状态栏输出
  }
}

function resolveTranscriptPath(stdin) {
  const candidates = [];
  if (typeof stdin?.transcript_path === 'string' && stdin.transcript_path.trim()) {
    const raw = stdin.transcript_path.trim();
    const expanded = raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
    if (expanded.endsWith('.jsonl')) candidates.push(expanded);
  }
  const convId = stdin?.conversation_id || stdin?.session_id;
  if (typeof convId === 'string' && convId.trim()) {
    candidates.push(
      path.join(
        os.homedir(),
        '.gemini',
        'antigravity-cli',
        'brain',
        convId.trim(),
        '.system_generated',
        'logs',
        'transcript.jsonl',
      ),
    );
  }
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function readTranscriptStats(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  try {
    const stat = fs.statSync(transcriptPath);
    const cached = readJsonSafe(TRANSCRIPT_CACHE_FILE, {});
    if (
      cached.version === 2 &&
      cached.path === transcriptPath &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size
    ) {
      return cached.stats;
    }

    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
    const rows = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // 忽略未写完的半行
      }
    }

    let inputTokens = 0;
    let cacheReadTokens = 0;
    let outputTokens = 0;
    let lastContext = 0;
    let lastModel = null;
    let firstTs = null;
    let turns = 0;

    // 追踪当前用户回合与上一回合内仅包含模型生成的耗时（排除工具执行等待时间）
    let prevTurnTokens = 0;
    let prevTurnMs = 0;
    let turnCompletedTokens = 0;
    let turnCompletedMs = 0;
    let trailingPlanner = null;

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const rowTs = row.created_at ? Date.parse(row.created_at) : NaN;
      if (!firstTs && Number.isFinite(rowTs)) firstTs = rowTs;

      if (row.type === 'USER_INPUT') {
        if (turnCompletedTokens > 0 && turnCompletedMs > 0) {
          prevTurnTokens = turnCompletedTokens;
          prevTurnMs = turnCompletedMs;
        }
        turnCompletedTokens = 0;
        turnCompletedMs = 0;
        trailingPlanner = null;
        continue;
      }

      if (row.type === 'PLANNER_RESPONSE') {
        const inp = Number(row.input_tokens) || 0;
        const cr = Number(row.cache_read_tokens) || 0;
        const out = Number(row.output_tokens) || 0;
        inputTokens += inp;
        cacheReadTokens += cr;
        outputTokens += out;
        if (inp + cr + out > 0) lastContext = inp + cr + out;
        if (row.model) lastModel = row.model;
        turns += 1;

        if (out > 0 && Number.isFinite(rowTs)) {
          const next = i + 1 < rows.length ? rows[i + 1] : null;
          const nextTs = next?.created_at ? Date.parse(next.created_at) : NaN;
          if (next && next.type !== 'USER_INPUT' && Number.isFinite(nextTs)) {
            const durMs = Math.max(500, nextTs - rowTs);
            if (durMs <= MAX_STEP_DURATION_MS) {
              turnCompletedTokens += out;
              turnCompletedMs += durMs;
            }
            trailingPlanner = null;
          } else {
            // 当前回合的最后一条模型响应（如最终回复，后方暂无工具步骤）
            trailingPlanner = {
              stepIndex: row.step_index ?? i,
              startMs: rowTs,
              outputTokens: out,
              model: row.model || null,
            };
          }
        }
      }
    }

    const totalPrompt = inputTokens + cacheReadTokens;
    const cacheHitPct = totalPrompt > 0 ? Math.round((cacheReadTokens / totalPrompt) * 100) : null;
    const stats = {
      inputTokens,
      cacheReadTokens,
      outputTokens,
      lastContext,
      lastModel,
      cacheHitPct,
      turns,
      firstTs,
      mtimeMs: stat.mtimeMs,
      turnCompletedTokens,
      turnCompletedMs,
      prevTurnTokens,
      prevTurnMs,
      trailingPlanner,
    };
    writeJsonSafe(TRANSCRIPT_CACHE_FILE, {
      version: 2,
      path: transcriptPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      stats,
    });
    return stats;
  } catch {
    return null;
  }
}

function getSpeedCachePath(stdin, transcriptPath) {
  const key =
    stdin?.conversation_id ||
    stdin?.session_id ||
    transcriptPath ||
    stdin?.workspace?.current_dir ||
    stdin?.cwd ||
    'default';
  const hash = createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
  return path.join(SPEED_CACHE_DIR, `${hash}.json`);
}

function computeTokenSpeed(stdin, transcript, transcriptPath) {
  const now = Date.now();
  const cachePath = getSpeedCachePath(stdin, transcriptPath);
  const st = readJsonSafe(cachePath, {}) || {};

  // 路径 1：基于 transcript.jsonl 精确计算当前回合模型净输出速率（已剔除工具执行耗时）
  if (transcript) {
    let totalTok = transcript.turnCompletedTokens || 0;
    let totalMs = transcript.turnCompletedMs || 0;

    const tp = transcript.trailingPlanner;
    if (tp && tp.outputTokens > 0 && Number.isFinite(tp.startMs)) {
      let completedAt = null;
      if (st.trailingStepIndex === tp.stepIndex && Number.isFinite(st.trailingCompletedAt)) {
        completedAt = st.trailingCompletedAt;
      } else {
        // 若刚写入（<= 2.5 秒），用当前精确时间；否则（恢复历史会话）用文件最后修改时间
        completedAt =
          Number.isFinite(transcript.mtimeMs) && now - transcript.mtimeMs > 2_500
            ? transcript.mtimeMs
            : now;
        st.trailingStepIndex = tp.stepIndex;
        st.trailingCompletedAt = completedAt;
      }
      const durMs = Math.max(500, completedAt - tp.startMs);
      if (durMs <= MAX_STEP_DURATION_MS) {
        totalTok += tp.outputTokens;
        totalMs += durMs;
      }
    }

    let speed = null;
    if (totalTok > 0 && totalMs >= 500) {
      speed = totalTok / (totalMs / 1000);
    } else if (transcript.prevTurnTokens > 0 && transcript.prevTurnMs >= 500) {
      speed = transcript.prevTurnTokens / (transcript.prevTurnMs / 1000);
    } else if (Number.isFinite(st.lastSpeed)) {
      speed = st.lastSpeed;
    }

    if (Number.isFinite(speed) && speed > 0 && speed <= MAX_PLAUSIBLE_TPS) {
      st.lastSpeed = speed;
      st.updatedAt = now;
      writeJsonSafe(cachePath, st);
      return speed;
    }
  }

  // 路径 2：兜底（无可读 transcript.jsonl 时，通过 stdin.context_window 输出增量与状态切换估算）
  const ctx = stdin?.context_window;
  const totalOut = Number(ctx?.total_output_tokens);
  const curOut = Number(ctx?.current_usage?.output_tokens);
  const outCounter =
    Number.isFinite(totalOut) && totalOut >= 0
      ? totalOut
      : Number.isFinite(curOut) && curOut >= 0
        ? curOut
        : null;
  const state = String(stdin?.agent_state || '');
  const isActive = state && state !== 'idle';

  if (outCounter !== null) {
    if (isActive && st.lastState === 'idle') {
      st.activeStartTs = now;
    }
    if (typeof st.lastOut === 'number' && outCounter > st.lastOut) {
      const delta = outCounter - st.lastOut;
      const dtPoll = Number.isFinite(st.lastChangeTs) ? now - st.lastChangeTs : 0;
      const dtActive = Number.isFinite(st.activeStartTs) ? now - st.activeStartTs : dtPoll;
      // 流式小步增量用累加窗口，整步跳变用活跃开始时刻
      if (dtPoll >= 300 && dtPoll <= 3_000) {
        if (!st.streamLastAt || now - st.streamLastAt > 30_000) {
          st.streamTokens = 0;
          st.streamMs = 0;
        }
        st.streamTokens = (st.streamTokens || 0) + delta;
        st.streamMs = (st.streamMs || 0) + dtPoll;
        st.streamLastAt = now;
        if (st.streamMs >= 500) {
          st.lastSpeed = st.streamTokens / (st.streamMs / 1000);
        }
      } else if (dtActive >= 500 && dtActive <= MAX_STEP_DURATION_MS) {
        st.lastSpeed = delta / (dtActive / 1000);
      }
      st.lastChangeTs = now;
      st.activeStartTs = now;
    } else if (typeof st.lastOut !== 'number' || outCounter < st.lastOut) {
      st.lastChangeTs = now;
      if (isActive) st.activeStartTs = now;
    }
    st.lastOut = outCounter;
    st.lastState = state;
    st.updatedAt = now;
    writeJsonSafe(cachePath, st);
  }

  return Number.isFinite(st.lastSpeed) && st.lastSpeed > 0 && st.lastSpeed <= MAX_PLAUSIBLE_TPS
    ? st.lastSpeed
    : null;
}

function hasGitRepo(startDir) {
  let cur = startDir;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(cur, '.git'))) return true;
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  return false;
}

function getGitInfo(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const cached = readJsonSafe(GIT_CACHE_FILE, {});
  if (cached.dir === dir && cached.ts && Date.now() - cached.ts < GIT_TTL_MS) {
    return cached.info;
  }

  let info = null;
  if (hasGitRepo(dir)) {
    try {
      const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 180,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (branch) {
        let dirty = false;
        try {
          const st = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
            cwd: dir,
            encoding: 'utf8',
            timeout: 180,
            stdio: ['ignore', 'pipe', 'ignore'],
          });
          dirty = st.trim().length > 0;
        } catch {
          // 忽略脏状态检测超时
        }
        info = { branch, dirty };
      }
    } catch {
      info = null;
    }
  }

  writeJsonSafe(GIT_CACHE_FILE, { dir, ts: Date.now(), info });
  return info;
}

const EFFORT_ICONS = {
  low: '○',
  medium: '◑',
  med: '◑',
  high: '◕',
  xhigh: '●',
  max: '●',
};

function formatEffortTag(rawEffort) {
  const clean = String(rawEffort || '').trim();
  if (!clean) return '';
  const key = clean.toLowerCase();
  const icon = EFFORT_ICONS[key];
  const pretty =
    key === 'xhigh' ? 'XHigh' : clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
  return icon ? `${icon} ${pretty}` : pretty;
}

function formatModelDisplay(rawName, extraEffort) {
  const str = String(rawName || '').trim();
  if (!str) return '未选择模型';
  const m = str.match(/^(.*?)\s*\((low|medium|med|high|xhigh|max)\)\s*$/i);
  if (m) {
    return `${m[1].trim()} ${formatEffortTag(m[2])}`;
  }
  const effort = String(extraEffort || '').trim();
  if (effort && !str.toLowerCase().includes(effort.toLowerCase())) {
    return `${str} ${formatEffortTag(effort)}`;
  }
  return str;
}

function resolveActiveModel(stdin, transcript) {
  const display = stdin?.model?.display_name || stdin?.model?.id;
  const effort = stdin?.model?.effort || stdin?.effort;
  if (display) {
    return formatModelDisplay(display, effort);
  }
  if (transcript?.lastModel) return formatModelDisplay(transcript.lastModel, effort);
  const settings = readJsonSafe(path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json'), {});
  return formatModelDisplay(settings?.model || '未选择模型', effort);
}

function detectActivePool(modelName) {
  const m = String(modelName || '').toLowerCase();
  if (m.includes('argon')) return 'argon';
  if (m.includes('claude') || m.includes('gpt') || m.includes('opus') || m.includes('sonnet')) return '3p';
  return 'gemini';
}

function mergeQuotaBuckets(stdin, cache) {
  const groups = cache?.usage?.groups ? JSON.parse(JSON.stringify(cache.usage.groups)) : [];
  const stdinQuota = stdin?.quota;

  // 若 stdin 实时传回配额分桶，则覆盖缓存中的对应分桶剩余比例与重置时间
  if (stdinQuota && typeof stdinQuota === 'object') {
    for (const g of groups) {
      for (const b of g.buckets || []) {
        const live = stdinQuota[b.id];
        if (live && typeof live === 'object') {
          if (typeof live.remaining_fraction === 'number') {
            b.remaining_fraction = live.remaining_fraction;
          }
          if (typeof live.reset_in_seconds === 'number') {
            b.reset_in_seconds = live.reset_in_seconds;
          }
          if (typeof live.reset_time === 'string') {
            b.reset_time = live.reset_time;
          }
        }
      }
    }
  }
  return groups;
}

function bucketUsedPct(b) {
  const rem = typeof b?.remaining_fraction === 'number' ? b.remaining_fraction : null;
  if (rem === null) return null;
  return Math.max(0, Math.min(100, Math.round((1 - rem) * 100)));
}

function formatGroupSegment(group, key, isActive, compactMode) {
  const buckets = group.buckets || [];
  const b5h = buckets.find((b) => b.window === '5h' || String(b.id).endsWith('-5h'));
  const bw = buckets.find((b) => b.window === 'weekly' || String(b.id).endsWith('-weekly'));

  const activeLabelMap = {
    gemini: 'Gemini',
    '3p': 'Claude/GPT',
    argon: 'Argon',
  };
  const compactLabelMap = {
    gemini: 'Gemini',
    '3p': '3P',
    argon: 'Argon',
  };

  const p5 = b5h ? bucketUsedPct(b5h) : null;
  const pw = bw ? bucketUsedPct(bw) : null;
  if (p5 === null && pw === null) return null;

  const r5 = b5h ? formatResetCountdown(b5h.reset_time, b5h.reset_in_seconds) : '';
  const rw = bw ? formatResetCountdown(bw.reset_time, bw.reset_in_seconds) : '';

  if (isActive) {
    const label = activeLabelMap[key] || group.name;
    const parts = [];
    if (p5 !== null) {
      const c5 = colorByQuota(p5);
      const resetText = r5 ? ` ${DIM}(${r5})${RESET}` : '';
      if (!compactMode) {
        parts.push(`${DIM}5h${RESET} ${progressBar(p5, 8, colorByQuota)} ${c5}${p5}%${RESET}${resetText}`);
      } else {
        parts.push(`${DIM}5h${RESET} ${c5}${p5}%${RESET}${resetText}`);
      }
    }
    if (pw !== null) {
      const cw = colorByQuota(pw);
      const resetText = rw && !compactMode ? ` ${DIM}(${rw})${RESET}` : '';
      if (p5 === null && !compactMode) {
        parts.push(`${DIM}周${RESET} ${progressBar(pw, 8, colorByQuota)} ${cw}${pw}%${RESET}${resetText}`);
      } else {
        parts.push(`${DIM}周${RESET} ${cw}${pw}%${RESET}${resetText}`);
      }
    }
    const gap = compactMode ? ' ' : '  ';
    return `${BOLD}${label}${RESET}${gap}${parts.join(` ${DIM}·${RESET} `)}`;
  }

  // 非激活模型池：0% 时紧凑折叠为 `3P 0%` / `Argon 0%`，非 0% 时高亮显示实际消耗
  const shortLabel = compactLabelMap[key] || group.name;
  const maxPct = Math.max(p5 ?? 0, pw ?? 0);
  if (maxPct === 0) {
    return `${DIM}${shortLabel} 0%${RESET}`;
  }
  if (p5 !== null && pw !== null && p5 > 0 && pw > 0) {
    return `${DIM}${shortLabel}${RESET} ${colorByQuota(p5)}${p5}%${RESET}${DIM}/${RESET}${colorByQuota(pw)}${pw}%${RESET}`;
  }
  if (p5 !== null && p5 > 0) {
    return `${DIM}${shortLabel}${RESET} ${colorByQuota(p5)}${p5}%${RESET}`;
  }
  return `${DIM}${shortLabel} 周${RESET} ${colorByQuota(pw)}${pw}%${RESET}`;
}

function getTerminalCols(stdin) {
  return (
    Number(stdin?.terminal_width) ||
    Number(process.env.COLUMNS) ||
    process.stdout.columns ||
    120
  );
}

function buildLine1(stdin, transcript, modelName, tokenSpeed, compactMode) {
  const segs = [];

  // 左锚点：模型徽章 + 工作目录（及 Git 分支）
  const modelBadge = `${CYAN}${BOLD}[${modelName}]${RESET}`;
  const workDir = stdin?.workspace?.current_dir || stdin?.cwd;
  let projectText = '';
  if (workDir) {
    const dirName = path.basename(workDir) || workDir;
    const git = getGitInfo(workDir);
    const gitText = git
      ? ` ${MAGENTA}git:(${RESET}${CYAN}${git.branch}${git.dirty ? '*' : ''}${RESET}${MAGENTA})${RESET}`
      : '';
    projectText = `${YELLOW}${dirName}${RESET}${gitText}`;
  }
  const gap = compactMode ? ' ' : '  ';
  segs.push(projectText ? `${modelBadge}${gap}${projectText}` : modelBadge);

  // 上下文占用进度条
  const ctx = stdin?.context_window;
  let usedPct = typeof ctx?.used_percentage === 'number' ? Math.round(ctx.used_percentage) : null;
  const ctxSize = Number(ctx?.context_window_size) || 0;
  const currentUsageTokens = ctx?.current_usage
    ? (Number(ctx.current_usage.input_tokens) || 0) +
      (Number(ctx.current_usage.cache_read_input_tokens) || 0) +
      (Number(ctx.current_usage.cache_creation_input_tokens) || 0) +
      (Number(ctx.current_usage.output_tokens) || 0)
    : 0;
  const usedTokens =
    currentUsageTokens > 0
      ? currentUsageTokens
      : usedPct !== null && ctxSize > 0
        ? Math.round((usedPct / 100) * ctxSize)
        : transcript?.lastContext || 0;

  if (usedPct === null && ctxSize > 0 && usedTokens > 0) {
    usedPct = Math.min(100, Math.round((usedTokens / ctxSize) * 100));
  }

  if (usedPct !== null) {
    const cc = colorByContext(usedPct);
    const tokText =
      ctxSize > 0 && usedTokens > 0
        ? ` ${DIM}(${formatTokens(usedTokens)}/${formatTokens(ctxSize)})${RESET}`
        : '';
    segs.push(`${progressBar(usedPct, 8, colorByContext)} ${cc}${usedPct}%${RESET}${tokText}`);
  } else if (usedTokens > 0) {
    segs.push(`${DIM}上下文 ${formatTokens(usedTokens)}${RESET}`);
  }

  // 输出速度（若有 API 计费信息则一并展示）
  const costUsd = stdin?.cost?.total_usd ?? stdin?.cost?.total_cost_usd;
  const costStr = formatUsd(costUsd);
  const subUsd = stdin?.cost?.subagent_usd;
  const subStr = Number(subUsd) > 0 ? formatUsd(subUsd) : null;

  const metricParts = [];
  if (costStr) {
    metricParts.push(`${YELLOW}~${costStr}${RESET}${subStr ? `${DIM}(子${subStr})${RESET}` : ''}`);
  }
  const speedStr = formatSpeed(tokenSpeed);
  if (speedStr) {
    metricParts.push(`${CYAN}${speedStr}${RESET}`);
  }
  if (metricParts.length > 0) segs.push(metricParts.join(` ${DIM}·${RESET} `));

  // 运行中的子代理数量
  if (Array.isArray(stdin?.subagents) && stdin.subagents.length > 0) {
    segs.push(`${MAGENTA}子代理×${stdin.subagents.length}${RESET}`);
  }

  const sep = compactMode ? ` ${DIM}│${RESET} ` : `  ${DIM}│${RESET}  `;
  return segs.join(sep);
}

function buildLine2(stdin, cache, activeModel, compactMode) {
  const groups = mergeQuotaBuckets(stdin, cache);
  const activePool = detectActivePool(activeModel);

  if (groups.length === 0) {
    const err = cache?.lastError ? ` (${cache.lastError})` : '';
    return `${DIM}正在后台拉取 /usage 配额…${err}${RESET}`;
  }

  const activeSegs = [];
  const otherSegs = [];
  for (const g of groups) {
    const name = String(g.name || '').toLowerCase();
    let key = 'other';
    if (name.includes('argon')) key = 'argon';
    else if (name.includes('claude') || name.includes('gpt')) key = '3p';
    else if (name.includes('gemini')) key = 'gemini';

    const isActive = key === activePool;
    const seg = formatGroupSegment(g, key, isActive, compactMode);
    if (!seg) continue;
    if (isActive) activeSegs.push(seg);
    else otherSegs.push(seg);
  }
  const groupSegs = [...activeSegs, ...otherSegs];

  // 补充积分余额（来自缓存或 stdin）
  const credits =
    typeof stdin?.credits?.remaining_credits === 'number'
      ? stdin.credits.remaining_credits
      : cache?.credits?.remaining_credits;
  if (typeof credits === 'number' && credits > 0) {
    groupSegs.push(`${CYAN}积分 ${credits}${RESET}`);
  }

  // 缓存陈旧提示（超过 5 分钟未成功刷新时提醒）
  if (cache?.updatedAt && Date.now() - cache.updatedAt > 5 * 60_000) {
    const mins = Math.round((Date.now() - cache.updatedAt) / 60_000);
    groupSegs.push(`${DIM}${mins}m前${RESET}`);
  }

  const sep = compactMode ? ` ${DIM}│${RESET} ` : `  ${DIM}│${RESET}  `;
  return groupSegs.join(sep);
}

function main() {
  const stdin = readStdin();
  const cache = readJsonSafe(CACHE_FILE, null);
  maybeTriggerUsageRefresh(cache);

  const transcriptPath = resolveTranscriptPath(stdin);
  const transcript = readTranscriptStats(transcriptPath);
  const tokenSpeed = computeTokenSpeed(stdin, transcript, transcriptPath);
  const modelName = resolveActiveModel(stdin, transcript);
  const compactMode = getTerminalCols(stdin) < 96;

  const line1 = buildLine1(stdin, transcript, modelName, tokenSpeed, compactMode);
  const line2 = buildLine2(stdin, cache, modelName, compactMode);

  process.stdout.write(`${line1}\n${line2}${RESET}\n`);
}

main();
