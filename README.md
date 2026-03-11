# codex-runner

一个把 Codex CLI 接到 QQ 机器人的轻量 runner。

当前实现特点：

- 使用 `codex exec` / `codex exec resume --last` 串行处理消息
- 保持同一个 Codex 会话上下文，收到 `/new` 后重置
- 对高风险命令增加 QQ 侧审批：`/allow`、`/skip`、`/reject`
- 支持在 `.env` 里指定 `node`、`python`、`npm`、`npx`、`pip` 的具体路径

## 环境要求

- Node.js 22 或更高版本
- 已安装并可登录使用的 Codex CLI
- 一个可用的 QQ 机器人应用

网络说明：

- Codex 登录、更新、部分模型能力和相关依赖访问依赖外网
- 如果你的网络环境访问不稳定，请自带梯子

## 安装 Node.js

如果本机还没有 Node.js，可以先安装。

官方安装包：

```bash
https://nodejs.org/
```

macOS 使用 Homebrew：

```bash
brew install node
```

安装完成后确认：

```bash
node -v
npm -v
```

## 安装 Codex CLI

全局安装：

```bash
npm install -g @openai/codex
```

安装完成后确认：

```bash
codex --version
```

首次使用需要登录：

```bash
codex login
```

## 安装项目依赖

进入项目目录后执行：

```bash
npm install
```

## 配置 `.env`

先复制示例文件：

```bash
cp .env.example .env
```

创建 QQ 机器人并获取 `AppID`、`AppSecret`：

- 入口文档：`https://q.qq.com/qqbot/openclaw/index.html`
- 在 QQ 机器人开放平台创建机器人应用
- 创建完成后，在平台后台获取 `AppID` 和 `AppSecret`

最少需要配置：

```env
QQ_BOT_APP_ID=your_app_id
QQ_BOT_SECRET=your_client_secret
QQ_BOT_SANDBOX=true
QQ_BOT_INTENTS=PUBLIC_GUILD_MESSAGES,GROUP_AND_C2C
```

可选配置：

```env
# Codex 路径；不填则直接执行 codex
CODEX_BIN=/absolute/path/to/codex

# 如果 codex 是 node 脚本，可指定 node 路径；不填则使用当前 node
CODEX_NODE=/absolute/path/to/node

# 留空表示直接执行系统里的对应命令
NODE_BIN=
NPM_BIN=
NPX_BIN=
PYTHON_BIN=
PYTHON3_BIN=
PIP_BIN=
PIP3_BIN=
```

这些 `*_BIN` 的作用是：

- 如果填写绝对路径，Codex 在执行对应命令时会优先使用你指定的二进制
- 如果留空，仍然按系统环境直接执行 `node`、`python`、`npm`、`npx`、`pip` 等命令

## 启动

直接启动：

```bash
node main.js
```

或者给脚本执行权限后启动：

```bash
chmod +x main.js
./main.js
```

## 机器人行为说明

普通消息：

- 机器人会把消息交给 Codex 处理
- 后续消息默认会继续沿用上一轮会话上下文

重置会话：

```text
/new
```

审批命令：

当 Codex 判断某个操作属于高风险命令时，机器人会先把命令发给用户，并等待下面三种回复之一：

```text
/allow
/skip
/reject
```

含义：

- `/allow`：批准执行该命令并继续任务
- `/skip`：跳过这个命令，要求 Codex 用别的办法继续
- `/reject`：取消本次执行并退出当前实例

## 常见问题

### 1. `codex: command not found`

说明系统里没有可执行的 Codex CLI。先安装：

```bash
npm install -g @openai/codex
```

或者在 `.env` 中显式指定：

```env
CODEX_BIN=/absolute/path/to/codex
```

### 2. Node / Python 版本不对

在 `.env` 里为对应命令指定绝对路径，例如：

```env
NODE_BIN=/absolute/path/to/node
PYTHON3_BIN=/absolute/path/to/python3
PIP3_BIN=/absolute/path/to/pip3
```

### 3. 登录或执行失败

优先检查：

- `codex login` 是否已完成
- 外网是否可访问
- 是否需要自带梯子
- QQ 机器人 `AppID` 和 `Secret` 是否正确
