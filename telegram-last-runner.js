#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

function loadDotEnv(filename = '.env') {
  const envPath = path.resolve(process.cwd(), filename);
  let content;
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');

    if (typeof process.env[key] === 'undefined') {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_ALLOWED_USER_ID = Number(process.env.TELEGRAM_ALLOWED_USER_ID || 0);
const TELEGRAM_API_HOST = process.env.TELEGRAM_API_HOST || 'api.telegram.org';
const TELEGRAM_PROXY = process.env.TELEGRAM_PROXY || '';
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const CODEX_WORKDIR = path.resolve(process.env.CODEX_WORKDIR || process.cwd());
const EXEC_TIMEOUT_MS = Number(process.env.CODEX_EXEC_TIMEOUT_MS || 30 * 60 * 1000);
const POLL_TIMEOUT_SECONDS = Number(process.env.TELEGRAM_POLL_TIMEOUT_SECONDS || 30);
const MAX_REPLY_CHARS = Number(process.env.TELEGRAM_MAX_REPLY_CHARS || 30000);
const MAX_CHUNK_CHARS = Number(process.env.TELEGRAM_MAX_CHUNK_CHARS || 3500);

if (!TELEGRAM_BOT_TOKEN) {
  fail('Missing TELEGRAM_BOT_TOKEN');
}
if (!Number.isSafeInteger(TELEGRAM_ALLOWED_USER_ID) || TELEGRAM_ALLOWED_USER_ID <= 0) {
  fail('Missing TELEGRAM_ALLOWED_USER_ID');
}

let offset = 0;
let hasConversation = false;
let telegramAgentPromise = null;

main().catch((err) => {
  fail(err && err.stack ? err.stack : String(err));
});

async function main() {
  log(`Telegram Codex runner started. workdir=${CODEX_WORKDIR}`);
  if (TELEGRAM_PROXY) {
    log(`Telegram proxy enabled: ${proxyForLog(TELEGRAM_PROXY)}`);
  }
  for (;;) {
    let updates;
    try {
      updates = await telegram('getUpdates', {
        offset,
        timeout: POLL_TIMEOUT_SECONDS,
        allowed_updates: ['message']
      });
    } catch (err) {
      log(`getUpdates failed: ${err.message}`);
      await sleep(3000);
      continue;
    }

    for (const update of updates.result) {
      offset = Math.max(offset, update.update_id + 1);
      await handleUpdate(update);
    }
  }
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message || !message.chat || !message.from) return;

  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = typeof message.text === 'string' ? message.text.trim() : '';

  if (userId !== TELEGRAM_ALLOWED_USER_ID) {
    log(`Ignored unauthorized user ${userId}`);
    return;
  }
  if (!text) return;

  if (text === '/new') {
    hasConversation = false;
    await sendMessage(chatId, '已重置会话。下一条普通消息会新开 Codex 会话。');
    return;
  }

  if (text === '/status') {
    await sendMessage(chatId, `状态：空闲\n会话：${hasConversation ? '将使用 resume --last' : '下一次新建'}\n目录：${CODEX_WORKDIR}`);
    return;
  }

  if (text.startsWith('/')) {
    await sendMessage(chatId, '只支持 /new 和 /status。');
    return;
  }

  await sendMessage(chatId, hasConversation ? '继续上一个 Codex 会话...' : '新建 Codex 会话...');

  try {
    const result = await runCodex(text);
    hasConversation = true;
    await sendLongMessage(chatId, result);
  } catch (err) {
    await sendMessage(chatId, `执行失败：${err.message}`);
  }
}

function runCodex(prompt) {
  return new Promise((resolve, reject) => {
    const outputFile = path.join(os.tmpdir(), `telegram-codex-last-${process.pid}-${Date.now()}.txt`);
    const args = hasConversation
      ? ['exec', 'resume', '--last', '--skip-git-repo-check', '--json', '--output-last-message', outputFile, '-']
      : ['exec', '--skip-git-repo-check', '--json', '--output-last-message', outputFile, '-'];

    log(`Starting: ${CODEX_BIN} ${args.join(' ')}`);

    const child = childProcess.spawn(CODEX_BIN, args, {
      cwd: CODEX_WORKDIR,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch (_) {}
      cleanupFile(outputFile);
      reject(new Error(`Codex 执行超时（>${Math.floor(EXEC_TIMEOUT_MS / 1000)} 秒）。`));
    }, EXEC_TIMEOUT_MS);

    child.stdin.end(prompt);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanupFile(outputFile);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      const finalMessage = readFileIfExists(outputFile).trim();
      cleanupFile(outputFile);

      if (signal) {
        reject(new Error(`Codex 进程被信号 ${signal} 终止。`));
        return;
      }
      if (code !== 0) {
        reject(new Error(summarizeFailure(stderr, stdout)));
        return;
      }
      if (!finalMessage) {
        reject(new Error('Codex 执行成功，但没有产出最终消息。'));
        return;
      }
      resolve(finalMessage);
    });
  });
}

function telegram(method, payload) {
  const body = JSON.stringify(payload);
  return telegramRequest(method, body);
}

async function getTelegramAgent() {
  if (!TELEGRAM_PROXY) return undefined;

  if (!telegramAgentPromise) {
    telegramAgentPromise = import('socks-proxy-agent').then(({ SocksProxyAgent }) => new SocksProxyAgent(TELEGRAM_PROXY));
  }

  return telegramAgentPromise;
}

async function telegramRequest(method, body) {
  const agent = await getTelegramAgent();

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: TELEGRAM_API_HOST,
        path: `/bot${TELEGRAM_BOT_TOKEN}/${method}`,
        method: 'POST',
        agent,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body)
        }
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let data;
          try {
            data = JSON.parse(raw);
          } catch (err) {
            reject(new Error(`Telegram returned non-JSON response: ${raw.slice(0, 200)}`));
            return;
          }
          if (!data.ok) {
            reject(new Error(data.description || `Telegram ${method} failed`));
            return;
          }
          resolve(data);
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function proxyForLog(raw) {
  try {
    const parsed = new URL(raw);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch (_) {
    return '<invalid proxy url>';
  }
}

async function sendMessage(chatId, text) {
  await telegram('sendMessage', {
    chat_id: chatId,
    text: String(text || '').slice(0, MAX_CHUNK_CHARS)
  });
}

async function sendLongMessage(chatId, text) {
  const clean = String(text || '').slice(0, MAX_REPLY_CHARS);
  for (let i = 0; i < clean.length; i += MAX_CHUNK_CHARS) {
    await sendMessage(chatId, clean.slice(i, i + MAX_CHUNK_CHARS));
  }
}

function summarizeFailure(stderr, stdout) {
  const combined = [stderr, stdout].filter(Boolean).join('\n').trim();
  if (!combined) return 'Codex 未返回可读错误。';
  return combined.split(/\r?\n/).slice(-12).join('\n');
}

function readFileIfExists(filename) {
  try {
    return fs.readFileSync(filename, 'utf8');
  } catch (_) {
    return '';
  }
}

function cleanupFile(filename) {
  try {
    fs.unlinkSync(filename);
  } catch (_) {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  process.stderr.write(`[telegram-codex] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[telegram-codex] ${message}\n`);
  process.exit(1);
}
