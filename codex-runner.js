#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const WebSocket = require('ws');

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

function usage(exitCode = 1) {
  const msg = [
    'Usage:',
    '  codex-runner [--cmd <codex-bin>] -- <codex args...>',
    '  codex-runner --help',
    '',
    'Environment:',
    '  .env                    会在启动时自动读取当前目录下的 .env',
    '  QQ_BOT_APP_ID           QQ 机器人 AppID',
    '  QQ_BOT_SECRET           QQ 机器人 ClientSecret/AppSecret',
    '  QQ_BOT_SANDBOX          true/false，可选，默认 false',
    '  QQ_BOT_INTENTS          逗号分隔，可选，默认 PUBLIC_GUILD_MESSAGES,GROUP_AND_C2C',
    '  QQ_BOT_API_BASE         可选，默认 https://api.sgroup.qq.com',
    '  QQ_BOT_TOKEN_BASE       可选，默认 https://bots.qq.com',
    '',
    'Notes:',
    '  1. QQ 官方已禁用固定 Bot Token，当前实现使用 AccessToken 鉴权。',
    '  2. 当前实现使用 `codex exec` / `codex exec resume --last` 串行处理消息。',
    '  3. 收到 `/new` 会销毁当前会话并新开一个。',
    '  4. 对写文件、联网、安装、删除等高风险命令，runner 会先请求 QQ 用户审批。',
    ''
  ].join('\n');
  process.stderr.write(msg);
  process.exit(exitCode);
}

const argv = process.argv.slice(2);
const delimiterIndex = argv.indexOf('--');
const runnerArgv = delimiterIndex === -1 ? argv : argv.slice(0, delimiterIndex);
const forwardedArgv = delimiterIndex === -1 ? null : argv.slice(delimiterIndex + 1);

function shellQuote(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

function commandExists(cmd) {
  const check = childProcess.spawnSync('sh', ['-lc', `command -v ${shellQuote(cmd)} >/dev/null 2>&1`], {
    stdio: 'ignore'
  });
  return check.status === 0;
}

function resolveCommandPath(cmd) {
  if (cmd.includes('/')) return cmd;
  const out = childProcess.spawnSync('sh', ['-lc', `command -v ${shellQuote(cmd)} 2>/dev/null || true`], {
    encoding: 'utf8'
  });
  const resolved = (out.stdout || '').trim();
  return resolved.length > 0 ? resolved : cmd;
}

function firstLineOfFile(pathname, maxBytes = 200) {
  try {
    const fd = fs.openSync(pathname, 'r');
    try {
      const buf = Buffer.allocUnsafe(maxBytes);
      const n = fs.readSync(fd, buf, 0, maxBytes, 0);
      const text = buf.subarray(0, n).toString('utf8');
      const idx = text.indexOf('\n');
      return (idx === -1 ? text : text.slice(0, idx)).trimEnd();
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return null;
  }
}

function wrapNodeShebangIfNeeded(resolvedCmdPath, originalCmd, originalArgs) {
  const line = firstLineOfFile(resolvedCmdPath);
  if (!line || !line.startsWith('#!')) return { command: originalCmd, args: originalArgs };
  if (!/\bnode\b/.test(line)) return { command: originalCmd, args: originalArgs };

  let scriptPath = resolvedCmdPath;
  try {
    scriptPath = fs.realpathSync(resolvedCmdPath);
  } catch (_) {}

  const nodeBin = process.env.CODEX_NODE || process.execPath;
  return { command: nodeBin, args: [scriptPath, ...originalArgs] };
}

function parseBoolean(value, defaultValue) {
  if (typeof value !== 'string' || value.length === 0) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function requireEnv(name) {
  const value = process.env[name];
  if (typeof value === 'string' && value.length > 0) return value;
  process.stderr.write(`Missing required environment variable: ${name}\n\n`);
  usage(1);
}

function sanitizeMessageContent(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u0000/g, '')
    .trim();
}

function stripAtMentions(text) {
  return text.replace(/<@!?\d+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripAnsi(text) {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b][^\u0007]*(?:\u0007|\u001b\\)|\u001b[@-_]/g,
    ''
  );
}

function splitMessage(text, maxLength) {
  const normalized = sanitizeMessageContent(text);
  if (!normalized) return [];

  const parts = [];
  let remaining = normalized;
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf('\n', maxLength);
    if (cut < maxLength * 0.4) {
      cut = remaining.lastIndexOf(' ', maxLength);
    }
    if (cut < maxLength * 0.4) {
      cut = maxLength;
    }
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) {
    parts.push(remaining);
  }
  return parts.filter(Boolean);
}

function pathKeyForCommand(commandName) {
  return commandName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function shellSingleQuote(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

function nextMsgSeq() {
  return Math.floor(Math.random() * 65535) + 1;
}

const intentFlags = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  GROUP_AND_C2C: 1 << 25,
  FORUMS_EVENT: 1 << 28,
  AUDIO_ACTION: 1 << 29,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  MESSAGE_AUDIT: 1 << 27,
  INTERACTION: 1 << 26
};

function parseIntents(value) {
  const fallback = ['PUBLIC_GUILD_MESSAGES', 'GROUP_AND_C2C'];
  const intents = typeof value === 'string' && value.trim()
    ? value.split(',').map((item) => item.trim()).filter(Boolean)
    : fallback;
  const invalid = intents.filter((item) => !(item in intentFlags));
  if (invalid.length > 0) {
    process.stderr.write(`Invalid QQ_BOT_INTENTS values: ${invalid.join(', ')}\n`);
    process.exit(1);
  }
  return intents;
}

function intentsToBitmask(intents) {
  return intents.reduce((sum, name) => sum | intentFlags[name], 0);
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

function requestJson(method, urlString, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'utf-8',
          'Accept-Language': 'zh-CN,zh;q=0.8',
          Connection: 'keep-alive',
          'User-Agent': 'codex-runner',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers
        }
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch (_) {
            parsed = data;
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
            return;
          }

          const err = new Error(
            `HTTP ${res.statusCode} ${res.statusMessage || ''}: ${
              parsed && parsed.message ? parsed.message : typeof parsed === 'string' ? parsed : 'request failed'
            }`
          );
          err.statusCode = res.statusCode;
          err.responseBody = parsed;
          reject(err);
        });
      }
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

class QQBotClient {
  constructor(config) {
    this.appId = config.appId;
    this.secret = config.secret;
    this.apiBase = config.apiBase;
    this.tokenBase = config.tokenBase;
    this.sandbox = config.sandbox;
    this.intents = config.intents;
    this.intentsBitmask = intentsToBitmask(config.intents);
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    this.ws = null;
    this.seq = null;
    this.sessionId = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.stopped = false;
    this.handlers = [];
    this.ready = false;
  }

  authorizationHeader() {
    return `QQBot ${this.accessToken}`;
  }

  commonHeaders() {
    return {
      Authorization: this.authorizationHeader(),
      'X-Union-Appid': this.appId
    };
  }

  async ensureAccessToken(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && this.accessToken && now < this.accessTokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    log('Requesting QQ bot access token');
    const tokenUrl = new URL('/app/getAppAccessToken', this.tokenBase).toString();
    const response = await requestJson('POST', tokenUrl, {}, {
      appId: this.appId,
      clientSecret: this.secret
    });

    if (!response || !response.access_token) {
      throw new Error('Failed to obtain QQ bot access token');
    }

    this.accessToken = response.access_token;
    const expiresInSeconds = Number(response.expires_in || 0);
    this.accessTokenExpiresAt = Date.now() + expiresInSeconds * 1000;
    log('QQ bot access token acquired');
    return this.accessToken;
  }

  async request(method, pathname, body) {
    await this.ensureAccessToken();
    const url = new URL(pathname, this.apiBase).toString();
    try {
      return await requestJson(method, url, this.commonHeaders(), body);
    } catch (err) {
      if (err && (err.statusCode === 401 || err.statusCode === 403)) {
        await this.ensureAccessToken(true);
        return requestJson(method, url, this.commonHeaders(), body);
      }
      throw err;
    }
  }

  async getGateway() {
    return this.request('GET', '/gateway/bot');
  }

  async sendChannelMessage(channelId, payload) {
    return this.request('POST', `/channels/${channelId}/messages`, payload);
  }

  async sendC2CMessage(openid, payload) {
    return this.request('POST', `/v2/users/${openid}/messages`, payload);
  }

  onMessage(handler) {
    this.handlers.push(handler);
  }

  dispatchMessage(eventType, msg) {
    log(`Received event ${eventType} message_id=${msg && msg.id ? msg.id : 'unknown'}`);
    for (const handler of this.handlers) {
      Promise.resolve(handler(eventType, msg)).catch((err) => {
        log(`Message handler failed: ${err && err.message ? err.message : String(err)}`);
      });
    }
  }

  clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  scheduleReconnect(delayMs = 2000) {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    this.clearHeartbeat();
    this.ready = false;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch (err) {
        log(`QQ bot reconnect failed: ${err && err.message ? err.message : String(err)}`);
        this.scheduleReconnect(Math.min(delayMs * 2, 30_000));
      }
    }, delayMs);
  }

  heartbeatPayload() {
    return { op: 1, d: this.seq };
  }

  identifyPayload() {
    return {
      op: 2,
      d: {
        token: this.authorizationHeader(),
        intents: this.intentsBitmask,
        shard: [0, 1],
        properties: {
          $os: process.platform,
          $browser: 'codex-runner',
          $device: 'codex-runner'
        }
      }
    };
  }

  startHeartbeat(intervalMs) {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(this.heartbeatPayload()));
      }
    }, intervalMs);
  }

  async connect() {
    await this.ensureAccessToken();
    log(`Fetching QQ gateway from ${this.apiBase}`);
    const gateway = await this.getGateway();
    const gatewayUrl = gateway && gateway.url;
    if (!gatewayUrl) {
      throw new Error('Gateway URL missing from QQ API response');
    }
    log(`Connecting websocket ${gatewayUrl}`);

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(gatewayUrl);
      let settled = false;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch (_) {}
        reject(err);
      };

      ws.on('message', (raw) => {
        let packet;
        try {
          packet = JSON.parse(String(raw));
        } catch (err) {
          log(`Failed to parse websocket packet: ${String(err)}`);
          return;
        }

        if (typeof packet.s === 'number') {
          this.seq = packet.s;
        }

        if (packet.op === 10 && packet.d && packet.d.heartbeat_interval) {
          this.ws = ws;
          log('QQ websocket hello received, sending identify');
          ws.send(JSON.stringify(this.identifyPayload()));
          this.startHeartbeat(packet.d.heartbeat_interval);
          return;
        }

        if (packet.t === 'READY') {
          this.sessionId = packet.d && packet.d.session_id ? packet.d.session_id : null;
          this.ready = true;
          log(`QQ bot connected. Intents: ${this.intents.join(', ')}`);
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }

        if (packet.op === 9) {
          fail(new Error('QQ websocket invalid session'));
          return;
        }

        if (
          packet.t === 'AT_MESSAGE_CREATE' ||
          packet.t === 'MESSAGE_CREATE' ||
          packet.t === 'C2C_MESSAGE_CREATE'
        ) {
          this.dispatchMessage(packet.t, packet.d);
        }
      });

      ws.on('close', () => {
        this.ws = null;
        this.clearHeartbeat();
        if (!settled) {
          fail(new Error('QQ websocket closed before READY'));
          return;
        }
        this.scheduleReconnect();
      });

      ws.on('error', (err) => {
        if (!settled) {
          fail(err);
          return;
        }
        log(`QQ websocket error: ${err && err.message ? err.message : String(err)}`);
      });
    });
  }

  async close() {
    this.stopped = true;
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
  }
}

let command = process.env.CODEX_BIN || process.env.CODEX_COMMAND || 'codex';
let codexArgs = forwardedArgv ? forwardedArgv.slice() : [];
let commandPrefixArgs = [];

for (let i = 0; i < runnerArgv.length; i += 1) {
  const token = runnerArgv[i];
  if (token === '-h' || token === '--help') usage(0);
  if (token === '--cmd') {
    const next = runnerArgv[i + 1];
    if (typeof next !== 'string' || next.length === 0) {
      process.stderr.write('Error: --cmd requires a non-empty value.\n\n');
      usage(1);
    }
    command = next;
    i += 1;
    continue;
  }
  process.stderr.write(`Unknown runner argument: ${token}\n\n`);
  usage(1);
}

const resolvedCommandPath = resolveCommandPath(command);
({ command, args: codexArgs } = wrapNodeShebangIfNeeded(resolvedCommandPath, command, codexArgs));
if (command === (process.env.CODEX_NODE || process.execPath) && codexArgs.length > 0) {
  commandPrefixArgs = [codexArgs[0]];
  codexArgs = codexArgs.slice(1);
}

const qqBot = new QQBotClient({
  appId: requireEnv('QQ_BOT_APP_ID'),
  secret: process.env.QQ_BOT_SECRET || process.env.QQ_BOT_CLIENT_SECRET || process.env.QQ_BOT_APP_SECRET || requireEnv('QQ_BOT_SECRET'),
  intents: parseIntents(process.env.QQ_BOT_INTENTS),
  apiBase:
    process.env.QQ_BOT_API_BASE ||
    (parseBoolean(process.env.QQ_BOT_SANDBOX, false)
      ? 'https://sandbox.api.sgroup.qq.com'
      : 'https://api.sgroup.qq.com'),
  tokenBase: process.env.QQ_BOT_TOKEN_BASE || 'https://bots.qq.com',
  sandbox: parseBoolean(process.env.QQ_BOT_SANDBOX, false)
});

log(`QQ bot startup config: sandbox=${qqBot.sandbox ? 'true' : 'false'} apiBase=${qqBot.apiBase}`);

const MAX_BOT_MESSAGE_LENGTH = 1500;
const EXEC_TIMEOUT_MS = Number(process.env.CODEX_EXEC_TIMEOUT_MS || 10 * 60 * 1000);

const env = { ...process.env };
env.TERM = env.TERM || 'xterm-256color';
env.FORCE_COLOR = '0';
env.NO_COLOR = '1';

function buildCommandShim(commandName, fallbackPath, configuredPath) {
  const configured = sanitizeMessageContent(configuredPath);
  const fallback = sanitizeMessageContent(fallbackPath);
  const fallbackExec = fallback
    ? `exec ${shellSingleQuote(fallback)} "$@"`
    : [
        'PATH="$(printf \'%s\' \"$PATH\" | awk -v RS=: -v ORS=: \'$0 != ENVIRON[\"CODEX_RUNNER_SHIM_DIR\"] { print }\')"',
        'PATH="${PATH%:}"',
        `exec ${commandName} "$@"`
      ].join('\n');

  return [
    '#!/bin/sh',
    configured
      ? `exec ${shellSingleQuote(configured)} "$@"`
      : fallbackExec
  ].join('\n');
}

function createToolCommandShims() {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runner-shims-'));
  const commandNames = ['node', 'npm', 'npx', 'python', 'python3', 'pip', 'pip3'];

  for (const commandName of commandNames) {
    const envKey = `${pathKeyForCommand(commandName)}_BIN`;
    const configuredPath = process.env[envKey] || '';
    const fallbackPath = resolveCommandPath(commandName);
    const shimPath = path.join(shimDir, commandName);
    fs.writeFileSync(shimPath, buildCommandShim(commandName, fallbackPath, configuredPath), {
      encoding: 'utf8',
      mode: 0o755
    });
  }

  return shimDir;
}

const toolShimDir = createToolCommandShims();
env.CODEX_RUNNER_SHIM_DIR = toolShimDir;
env.PATH = `${toolShimDir}${path.delimiter}${env.PATH || ''}`;

const taskQueue = [];
let activeTask = null;
let codexSession = {
  hasConversation: false,
  busy: false,
  child: null
};
let pendingApproval = null;

const APPROVAL_POLICY_PROMPT = [
  '你正在通过 QQ 机器人与用户协作。',
  '对于只读、低风险、通常不需要用户审批的操作，你可以直接执行。',
  '对于任何通常需要用户审批的 shell 命令，绝对不要直接执行。',
  '这些需要审批的命令包括但不限于：写入或删除文件、修改 git 状态、安装或卸载依赖、联网请求、启动长期运行进程、访问工作区外路径、提升权限、系统级变更、潜在破坏性操作。',
  '遇到这类命令时，请不要调用命令工具，改为只输出下面的结构化块，不要输出其他内容：',
  '<approval_request>',
  '<command>完整命令</command>',
  '<reason>一句话说明为什么需要它</reason>',
  '</approval_request>',
  '当用户后续回复 /allow 时，表示批准执行你上一次申请审批的命令；你可以继续任务。',
  '当用户回复 /skip 时，表示不要执行那条命令，改用其他可行路径继续；如果没有替代方案，明确说明。',
  '当用户回复 /reject 时，表示取消这次任务并结束当前会话。'
].join('\n');

function buildExecCodexArgs(prompt, outputFile) {
  const commandArgs = codexArgs.length > 0 ? codexArgs.slice() : [];
  const resume = codexSession.hasConversation;
  const args = commandPrefixArgs.slice();
  args.push(...(resume ? ['exec', 'resume', '--last'] : ['exec']));
  args.push('--skip-git-repo-check', '--json', '--output-last-message', outputFile);
  args.push(...commandArgs);
  args.push(prompt);
  return args;
}

function buildUserTurnPrompt(input) {
  return `${APPROVAL_POLICY_PROMPT}\n\n[用户消息开始]\n${input}\n[用户消息结束]`;
}

function buildApprovalContinuationPrompt(action) {
  if (!pendingApproval) return '';
  if (action === 'allow') {
    return [
      APPROVAL_POLICY_PROMPT,
      '',
      '用户已批准你上一轮申请审批的命令。',
      `批准执行的命令：${pendingApproval.command}`,
      `审批原因：${pendingApproval.reason || '未提供'}`,
      '现在继续原任务。对于这条已批准的命令，不要再次申请审批。'
    ].join('\n');
  }
  if (action === 'skip') {
    return [
      APPROVAL_POLICY_PROMPT,
      '',
      '用户要求跳过你上一轮申请审批的命令，不允许执行它。',
      `禁止执行的命令：${pendingApproval.command}`,
      '请继续原任务，优先选择不需要审批的替代方案；如果没有替代方案，明确说明无法继续。'
    ].join('\n');
  }
  return '';
}

function parseExecJsonEvents(output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch (_) {}
  }
  return events;
}

function summarizeExecFailure(stderr, stdout) {
  const combined = sanitizeMessageContent([stderr, stdout].filter(Boolean).join('\n'));
  if (!combined) return 'Codex 未返回可读输出。';
  return combined.split('\n').slice(-12).join('\n');
}

function parseApprovalRequest(message) {
  const match = String(message || '').match(
    /<approval_request>\s*<command>([\s\S]*?)<\/command>\s*<reason>([\s\S]*?)<\/reason>\s*<\/approval_request>/i
  );
  if (!match) return null;
  const commandText = sanitizeMessageContent(match[1]);
  const reasonText = sanitizeMessageContent(match[2]);
  if (!commandText) return null;
  return {
    command: commandText,
    reason: reasonText
  };
}

function runCodexExec(prompt) {
  return new Promise((resolve, reject) => {
    const outputFile = path.join(os.tmpdir(), `codex-runner-last-${process.pid}-${Date.now()}.txt`);
    const args = buildExecCodexArgs(prompt, outputFile);
    log(`Starting Codex exec session: ${command} ${args.join(' ')}`);

    const child = childProcess.spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    codexSession.child = child;
    codexSession.busy = true;

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch (_) {}
      codexSession.child = null;
      codexSession.busy = false;
      reject(new Error(`Codex 执行超时（>${Math.floor(EXEC_TIMEOUT_MS / 1000)} 秒）。`));
    }, EXEC_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      codexSession.child = null;
      codexSession.busy = false;
      reject(err);
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      codexSession.child = null;
      codexSession.busy = false;

      let message = '';
      try {
        message = fs.readFileSync(outputFile, 'utf8');
      } catch (_) {}
      try {
        fs.unlinkSync(outputFile);
      } catch (_) {}

      const events = parseExecJsonEvents(stdout);
      const threadStarted = events.some((event) => event && event.type === 'thread.started');
      if (threadStarted) {
        codexSession.hasConversation = true;
      }

      if (signal) {
        reject(new Error(`Codex 进程被信号 ${signal} 终止。`));
        return;
      }
      if (code !== 0) {
        reject(new Error(summarizeExecFailure(stderr, stdout)));
        return;
      }

      const normalizedMessage = sanitizeMessageContent(message);
      if (!normalizedMessage) {
        reject(new Error('Codex 执行成功，但没有产出最终消息。'));
        return;
      }

      resolve(normalizedMessage);
    });
  });
}

async function resetCodexSession(context) {
  const previous = codexSession;
  codexSession = {
    hasConversation: false,
    busy: false,
    child: null
  };
  pendingApproval = null;
  if (previous && previous.child) {
    try {
      previous.child.kill('SIGTERM');
    } catch (_) {}
  }
  await safeSendReply(context, '已关闭当前 Codex 会话，下一条消息会启动新实例。');
}

async function sendReply(context, content) {
  const parts = splitMessage(content, MAX_BOT_MESSAGE_LENGTH);
  for (const part of parts) {
    if (context.type === 'c2c') {
      await qqBot.sendC2CMessage(context.openid, {
        content: part,
        msg_id: context.messageId,
        msg_type: 0,
        msg_seq: nextMsgSeq()
      });
    } else {
      const payload = {
        content: part,
        msg_id: context.messageId
      };
      await qqBot.sendChannelMessage(context.channelId, payload);
    }
  }
}

async function safeSendReply(context, content) {
  try {
    await sendReply(context, content);
  } catch (err) {
    log(`Failed to send bot reply: ${err && err.message ? err.message : String(err)}`);
  }
}

function sendTaskToInteractiveCodex(task) {
  return new Promise(async (resolve) => {
    if (codexSession.busy) {
      await safeSendReply(task.context, 'Codex 正在执行上一条消息，请稍候。');
      resolve();
      return;
    }

    await safeSendReply(task.context, `开始执行，队列剩余 ${taskQueue.length} 条。`);
    try {
      const prompt = task.kind === 'approval'
        ? buildApprovalContinuationPrompt(task.action)
        : buildUserTurnPrompt(task.input);
      const reply = await runCodexExec(prompt);
      const approvalRequest = parseApprovalRequest(reply);
      if (approvalRequest) {
        pendingApproval = {
          ...approvalRequest,
          context: task.context
        };
        const approvalMessage = [
          '检测到需要审批的操作：',
          approvalRequest.command,
          approvalRequest.reason ? `原因：${approvalRequest.reason}` : null,
          '回复 /allow 继续执行，/skip 跳过这个命令继续，/reject 取消执行并退出当前实例。'
        ].filter(Boolean).join('\n');
        await safeSendReply(task.context, approvalMessage);
      } else {
        pendingApproval = null;
        await safeSendReply(task.context, reply);
      }
    } catch (err) {
      await safeSendReply(task.context, err && err.message ? err.message : String(err));
    }
    resolve();
  });
}

async function processQueue() {
  if (activeTask || taskQueue.length === 0) return;

  const nextTask = taskQueue.shift();
  if (!nextTask) return;

  activeTask = nextTask;
  log(`Processing message ${nextTask.context.messageId}`);
  try {
    await sendTaskToInteractiveCodex(nextTask);
  } finally {
    activeTask = null;
    if (taskQueue.length > 0 && (!codexSession || !codexSession.busy)) {
      void processQueue();
    }
  }
}

function buildContext(eventType, message) {
  if (eventType === 'C2C_MESSAGE_CREATE') {
    return {
      type: 'c2c',
      openid:
        message && message.author
          ? message.author.user_openid || message.author.union_openid || message.author.id
          : null,
      messageId: message.id
    };
  }

  return {
    type: 'channel',
    channelId: message.channel_id,
    messageId: message.id
  };
}

async function enqueueMessage(eventType, message) {
  if (!message || !message.author) return;
  if (message.author.bot) return;
  if (String(message.author.id || '') === String(qqBot.appId)) return;

  const rawContent = sanitizeMessageContent(message.content);
  const input = eventType === 'AT_MESSAGE_CREATE' ? stripAtMentions(rawContent) : rawContent;
  if (!input) return;
  if (input === '/new') {
    await resetCodexSession(buildContext(eventType, message));
    return;
  }
  if (input === '/reject') {
    if (!pendingApproval) {
      await safeSendReply(buildContext(eventType, message), '当前没有待审批的操作。');
      return;
    }
    await resetCodexSession(buildContext(eventType, message));
    return;
  }
  if (input === '/allow' || input === '/skip') {
    if (!pendingApproval) {
      await safeSendReply(buildContext(eventType, message), '当前没有待审批的操作。');
      return;
    }
    const task = {
      input,
      context: buildContext(eventType, message),
      child: null,
      kind: 'approval',
      action: input === '/allow' ? 'allow' : 'skip'
    };
    const queuedAhead = (activeTask ? 1 : 0) + taskQueue.length;
    log(`Enqueue approval ${task.action} message_id=${task.context.messageId} queue_before=${queuedAhead}`);
    taskQueue.push(task);
    if (queuedAhead > 0) {
      await safeSendReply(task.context, `当前有任务执行中，已加入队列，前面还有 ${queuedAhead} 条。`);
    }
    void processQueue();
    return;
  }
  if (pendingApproval) {
    await safeSendReply(buildContext(eventType, message), '当前有待审批操作，请先回复 /allow、/skip 或 /reject。');
    return;
  }

  const task = {
    input,
    context: buildContext(eventType, message),
    child: null,
    kind: 'user',
    action: null
  };

  if (task.context.type === 'c2c' && !task.context.openid) {
    log(`Ignore ${eventType} message_id=${message.id} because user_openid is missing`);
    return;
  }

  const queuedAhead = (activeTask ? 1 : 0) + taskQueue.length;
  log(`Enqueue ${eventType} message_id=${task.context.messageId} queue_before=${queuedAhead}`);
  taskQueue.push(task);

  if (queuedAhead > 0) {
    await safeSendReply(task.context, `当前有任务执行中，已加入队列，前面还有 ${queuedAhead} 条。`);
  }

  void processQueue();
}

qqBot.onMessage(enqueueMessage);

['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((sig) => {
  process.on(sig, async () => {
    if (codexSession && codexSession.child) {
      try {
        codexSession.child.kill(sig);
      } catch (_) {}
    }
    await qqBot.close();
    process.exit(0);
  });
});

qqBot.connect().catch((err) => {
  log(`Failed to start QQ bot client: ${err && err.message ? err.message : String(err)}`);
  process.exit(1);
});
