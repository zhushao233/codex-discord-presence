#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readConfig } from "./config.js";
import { DiscordIpcClient } from "./discord-ipc.js";

const execFileAsync = promisify(execFile);
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const SESSION_ROOT =
  process.env.CODEX_SESSION_ROOT ||
  path.join(CODEX_HOME, "sessions");
const STATE_DB = path.join(CODEX_HOME, "state_5.sqlite");
const LOGS_DB = path.join(CODEX_HOME, "logs_2.sqlite");
const DATA_DIR = path.join(os.homedir(), ".codex-discord-presence");
const PID_FILE = path.join(DATA_DIR, "live.pid");
const STOP_FILE = path.join(DATA_DIR, "live.stop");
const LOG_FILE = path.join(DATA_DIR, "live.log");
const POLL_MS = Math.max(200, Number(process.env.CODEX_PRESENCE_POLL_MS) || 700);
const THREAD_CHECK_MS = 1000;
const APP_WINDOW_CHECK_MS = 3000;
const APP_IDLE_CHECK_MS = 5000;
const RECONNECT_MS = 15000;
const TAIL_BYTES = 512 * 1024;
const ANSWER_HOLD_MS = 4000;
const UI_TITLE_STALE_MS = 15000;
const UI_TITLE_STARTUP_GRACE_MS = 5000;
const UI_TITLE_RESTART_MS = 10000;
const THREAD_STALE_IDLE_MS = 20000;
const THREAD_QUIET_IDLE_MS = 45000;
const TITLE_HELPER = path.join(SERVER_DIR, "get-active-title.ps1");
const DETAILS =
  process.env.CODEX_PRESENCE_DETAILS || "Pair programming with ChatGPT";

const STATE_TEXT = {
  thinking: "Thinking…",
  answering: "Answering…",
  executing: "Running a command…",
  editing: "Editing a file…",
  computer: "Using the computer…",
  searching: "Searching the web…",
  tool: "Using a tool…",
  idle: "Idle",
};

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const stat = fs.statSync(LOG_FILE, { throwIfNoEntry: false });
    if (stat && stat.size > 256 * 1024) {
      fs.writeFileSync(LOG_FILE, "");
    }
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // Logging must never break presence updates.
  }
}

function toolState(name) {
  const tool = String(name || "").toLowerCase();
  if (
    tool.includes("exec_command") ||
    tool.includes("write_stdin") ||
    tool.includes("shell") ||
    tool === "bash"
  ) {
    return "executing";
  }
  if (
    tool.includes("apply_patch") ||
    tool.includes("write_file") ||
    tool.includes("edit_file")
  ) {
    return "editing";
  }
  if (tool.includes("cua") || tool.includes("computer") || tool.includes("browser")) {
    return "computer";
  }
  if (tool.includes("web") || tool.includes("search") || tool.includes("fetch")) {
    return "searching";
  }
  return "tool";
}

function stateForRecord(record) {
  if (!record || typeof record !== "object") {
    return null;
  }

  if (record.type === "event_msg") {
    const type = record.payload?.type;
    if (type === "task_started") {
      return "thinking";
    }
    if (type === "task_complete" || type === "turn_aborted") {
      return "idle";
    }
    return null;
  }

  if (record.type !== "response_item") {
    return null;
  }

  const item = record.payload || {};
  switch (item.type) {
    case "reasoning":
      return "thinking";
    case "message":
      if (item.role === "assistant") {
        return "answering";
      }
      if (item.role === "user") {
        return "thinking";
      }
      return null;
    case "function_call":
    case "custom_tool_call":
      return toolState(item.name);
    case "function_call_output":
    case "custom_tool_call_output":
      return "thinking";
    case "local_shell_call":
      return "executing";
    default:
      return null;
  }
}

function dayDir(date) {
  return path.join(
    SESSION_ROOT,
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  );
}

function latestSessionFile() {
  let best = null;
  const now = new Date();
  for (let offset = 0; offset <= 2; offset += 1) {
    const date = new Date(now.getTime() - offset * 86400000);
    const dir = dayDir(date);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) {
        continue;
      }
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        if (!best || stat.mtimeMs > best.mtimeMs) {
          best = { file, mtimeMs: stat.mtimeMs, size: stat.size };
        }
      } catch {
        // The file may disappear while scanning; ignore it.
      }
    }
  }
  return best;
}

class TailReader {
  constructor(file, onRecord) {
    this.file = file;
    this.onRecord = onRecord;
    this.offset = 0;
    this.remainder = "";
  }

  prime() {
    const stat = fs.statSync(this.file);
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const length = stat.size - start;
    if (length > 0) {
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(this.file, "r");
      try {
        fs.readSync(fd, buffer, 0, length, start);
      } finally {
        fs.closeSync(fd);
      }
      let text = buffer.toString("utf8");
      if (start > 0) {
        const newline = text.indexOf("\n");
        text = newline >= 0 ? text.slice(newline + 1) : "";
      }
      for (const line of text.split("\n")) {
        if (line.trim()) {
          this.#consume(line);
        }
      }
    }
    this.offset = stat.size;
    this.remainder = "";
  }

  poll() {
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch {
      return;
    }

    if (stat.size < this.offset) {
      this.offset = 0;
      this.remainder = "";
    }
    if (stat.size === this.offset) {
      return;
    }

    const length = stat.size - this.offset;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(this.file, "r");
    try {
      fs.readSync(fd, buffer, 0, length, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offset = stat.size;

    const text = this.remainder + buffer.toString("utf8");
    const lines = text.split("\n");
    this.remainder = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) {
        this.#consume(line);
      }
    }
  }

  #consume(line) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    this.onRecord(record);
  }
}

class LivePresence {
  constructor() {
    this.config = readConfig();
    this.client = null;
    this.state = null;
    this.tail = null;
    this.startedAt = Date.now();
    this.lastProcessCheck = 0;
    this.appRunning = null;
    this.lastConnectAttempt = 0;
    this.idleTimer = null;
    this.pushChain = Promise.resolve();
    this.activityVisible = false;
    this.priming = false;
    this.flushTimer = null;
    this.lastPushed = null;
    this.lastPushAt = 0;
    this.stopping = false;
    this.stateDb = null;
    this.logDb = null;
    this.stateThreadStmt = null;
    this.threadByTitleStmt = null;
    this.threadByTitlePrefixStmt = null;
    this.logMaxStmt = null;
    this.logEventStmt = null;
    this.latestThreadEventStmt = null;
    this.lastLogId = 0;
    this.lastThreadCheck = 0;
    this.activeThreadId = null;
    this.activeRollout = null;
    this.noActiveThread = false;
    this.titleProcess = null;
    this.titleBuffer = "";
    this.titleLastStart = 0;
    this.uiTitle = null;
    this.lastUiTitleAt = 0;
    this.lastUnmatchedTitle = null;
    this.lastQuietCheck = 0;
  }

  async checkAppRunning() {
    this.lastProcessCheck = Date.now();
    if (process.platform !== "win32") {
      this.appRunning = true;
      return;
    }
    try {
      const { stdout } = await execFileAsync(
        "tasklist",
        ["/FI", "IMAGENAME eq ChatGPT.exe", "/V", "/FO", "CSV", "/NH"],
        { windowsHide: true, timeout: 5000 }
      );
      const running = /"ChatGPT"\s*$/m.test(stdout);
      if (running && this.appRunning === false) {
        this.startedAt = Date.now();
      }
      this.appRunning = running;
    } catch {
      this.appRunning = true;
    }
  }

  openCodexDbs() {
    if (this.logDb && this.stateDb) {
      return true;
    }

    let stateDb = null;
    let logDb = null;
    try {
      if (!fs.existsSync(STATE_DB) || !fs.existsSync(LOGS_DB)) {
        return false;
      }

      stateDb = new DatabaseSync(STATE_DB, { readOnly: true });
      logDb = new DatabaseSync(LOGS_DB, { readOnly: true });
      const stateThreadStmt = stateDb.prepare(
        `select rollout_path, coalesce(nullif(name, ''), title, '') as label
         from threads where id = ?`
      );
      const threadByTitleStmt = stateDb.prepare(
        `select id from threads
         where archived = 0 and (name = ? or title = ?)
         order by updated_at_ms desc, recency_at_ms desc
         limit 1`
      );
      const threadByTitlePrefixStmt = stateDb.prepare(
        `select id from threads
         where archived = 0
           and substr(coalesce(nullif(name, ''), title, ''), 1, ?) = ?
         order by updated_at_ms desc, recency_at_ms desc
         limit 1`
      );
      const logMaxStmt = logDb.prepare(
        "select coalesce(max(id), 0) as id from logs"
      );
      const threadEventSql = `select id, thread_id from logs
        where thread_id is not null
          and (feedback_log_body like '%otel.name="thread/resume"%'
            or feedback_log_body like '%otel.name="thread/start"%')`;
      const logEventStmt = logDb.prepare(
        `${threadEventSql} and id > ? order by id desc limit 1`
      );
      const latestThreadEventStmt = logDb.prepare(
        `${threadEventSql} order by id desc limit 1`
      );

      this.stateDb = stateDb;
      this.logDb = logDb;
      this.stateThreadStmt = stateThreadStmt;
      this.threadByTitleStmt = threadByTitleStmt;
      this.threadByTitlePrefixStmt = threadByTitlePrefixStmt;
      this.logMaxStmt = logMaxStmt;
      this.logEventStmt = logEventStmt;
      this.latestThreadEventStmt = latestThreadEventStmt;
      this.lastLogId = Number(logMaxStmt.get()?.id || 0);

      const latest = latestThreadEventStmt.get();
      if (latest?.thread_id && !this.shouldDeferToUiTitle()) {
        this.activateThread(latest.thread_id);
      }
      log("Codex databases connected");
      return true;
    } catch (error) {
      log(`Codex database connect failed: ${error.message}`);
      try {
        logDb?.close();
      } catch {
        // Ignore cleanup failures.
      }
      try {
        stateDb?.close();
      } catch {
        // Ignore cleanup failures.
      }
      this.stateDb = null;
      this.logDb = null;
      this.stateThreadStmt = null;
      this.threadByTitleStmt = null;
      this.threadByTitlePrefixStmt = null;
      this.logMaxStmt = null;
      this.logEventStmt = null;
      this.latestThreadEventStmt = null;
      return false;
    }
  }

  closeCodexDbs() {
    try {
      this.logDb?.close();
    } catch {
      // Ignore cleanup failures.
    }
    try {
      this.stateDb?.close();
    } catch {
      // Ignore cleanup failures.
    }
    this.logDb = null;
    this.stateDb = null;
    this.stateThreadStmt = null;
    this.threadByTitleStmt = null;
    this.threadByTitlePrefixStmt = null;
    this.logMaxStmt = null;
    this.logEventStmt = null;
    this.latestThreadEventStmt = null;
    this.lastLogId = 0;
    this.lastThreadCheck = 0;
    this.activeThreadId = null;
    this.activeRollout = null;
    this.noActiveThread = false;
  }

  activateThread(threadId) {
    if (!threadId || threadId === this.activeThreadId) {
      this.resolveActiveRollout();
      return;
    }

    this.activeThreadId = threadId;
    this.activeRollout = null;
    this.noActiveThread = false;
    this.tail = null;
    this.state = null;
    this.lastPushed = null;
    this.cancelIdle();
    log(`active thread=${threadId.slice(-8)}`);
    this.resolveActiveRollout();
  }

  shouldPreferUiTitle() {
    return (
      process.platform === "win32" &&
      this.lastUiTitleAt > 0 &&
      Date.now() - this.lastUiTitleAt < UI_TITLE_STALE_MS
    );
  }

  shouldDeferToUiTitle() {
    return (
      process.platform === "win32" &&
      Boolean(this.titleProcess) &&
      !this.lastUiTitleAt &&
      Date.now() - this.titleLastStart < UI_TITLE_STARTUP_GRACE_MS
    );
  }

  startTitleWatcher() {
    if (process.platform !== "win32" || this.titleProcess) {
      return;
    }
    if (Date.now() - this.titleLastStart < UI_TITLE_RESTART_MS) {
      return;
    }
    if (!fs.existsSync(TITLE_HELPER)) {
      return;
    }

    this.titleLastStart = Date.now();
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        TITLE_HELPER,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    this.titleProcess = child;
    this.titleBuffer = "";
    log("UI title watcher started");

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => this.consumeTitleOutput(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) {
        log(`UI title helper: ${message.slice(0, 300)}`);
      }
    });
    child.on("error", (error) => {
      if (this.titleProcess === child) {
        this.titleProcess = null;
      }
      log(`UI title helper failed: ${error.message}`);
    });
    child.on("exit", (code) => {
      if (this.titleProcess === child) {
        this.titleProcess = null;
      }
      log(`UI title watcher exited code=${code}`);
    });
  }

  consumeTitleOutput(chunk) {
    this.titleBuffer += chunk;
    const lines = this.titleBuffer.split(/\r?\n/);
    this.titleBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        continue;
      }
      const title = String(payload?.title || "").trim();
      if (title) {
        this.lastUiTitleAt = Date.now();
        this.handleUiTitle(title);
      }
    }
  }

  handleUiTitle(title) {
    if (
      title === this.uiTitle &&
      (this.activeThreadId || this.noActiveThread)
    ) {
      return;
    }
    this.uiTitle = title;

    if (this.isUnboundUiTitle(title)) {
      this.activateNoThread(title);
      return;
    }

    const threadId = this.findThreadByTitle(title);
    if (!threadId) {
      if (title !== this.lastUnmatchedTitle) {
        log(`UI title unmatched: ${title}`);
        this.lastUnmatchedTitle = title;
      }
      this.uiTitle = null;
      return;
    }
    this.lastUnmatchedTitle = null;
    if (threadId === this.activeThreadId) {
      log(`UI title confirmed: ${title}`);
      return;
    }

    log(`UI selected: ${title}`);
    this.activateThread(threadId);
  }

  isUnboundUiTitle(title) {
    return /^(new chat|new conversation|新聊天|新对话|chatgpt|codex)$/i.test(title);
  }

  activateNoThread(title) {
    this.activeThreadId = null;
    this.activeRollout = null;
    this.tail = null;
    this.state = null;
    this.lastPushed = null;
    this.noActiveThread = true;
    this.cancelIdle();
    log(`UI selected no thread: ${title}`);
    this.setState("idle");
  }

  findThreadByTitle(title) {
    if (!this.threadByTitleStmt && !this.openCodexDbs()) {
      return null;
    }
    try {
      const exact = this.threadByTitleStmt?.get(title, title);
      if (exact?.id) {
        return exact.id;
      }
      const prefix = title.replace(/[…]+$/u, "").trim();
      if (prefix.length >= 8) {
        const partial = this.threadByTitlePrefixStmt?.get(prefix.length, prefix);
        if (partial?.id) {
          return partial.id;
        }
      }
    } catch (error) {
      log(`UI title lookup failed: ${error.message}`);
      this.closeCodexDbs();
    }
    return null;
  }

  resolveActiveRollout() {
    if (!this.activeThreadId || !this.stateThreadStmt) {
      return;
    }

    let row;
    try {
      row = this.stateThreadStmt.get(this.activeThreadId);
    } catch (error) {
      log(`active thread lookup failed: ${error.message}`);
      return;
    }
    if (!row?.rollout_path) {
      return;
    }

    const file =
      process.platform === "win32" && row.rollout_path.startsWith("\\\\?\\")
        ? row.rollout_path.slice(4)
        : row.rollout_path;
    if (file === this.activeRollout) {
      return;
    }

    this.activeRollout = file;
    this.tail = null;
    this.state = null;
    this.lastPushed = null;
    log(`following ${row.label || path.basename(file)}`);
  }

  pollActiveThread() {
    if (Date.now() - this.lastThreadCheck < THREAD_CHECK_MS) {
      return;
    }
    this.lastThreadCheck = Date.now();

    if (!this.openCodexDbs()) {
      return;
    }
    try {
      const maxId = Number(this.logMaxStmt.get()?.id || 0);
      if (maxId > this.lastLogId) {
        if (!this.shouldPreferUiTitle()) {
          const event = this.logEventStmt.get(this.lastLogId);
          if (event?.thread_id) {
            this.activateThread(event.thread_id);
          }
        }
        this.lastLogId = maxId;
      }
      if (
        !this.activeThreadId &&
        !this.shouldPreferUiTitle() &&
        !this.shouldDeferToUiTitle()
      ) {
        const latest = this.latestThreadEventStmt.get();
        if (latest?.thread_id) {
          this.activateThread(latest.thread_id);
        }
      }
      this.resolveActiveRollout();
    } catch (error) {
      log(`active thread poll failed: ${error.message}`);
      this.closeCodexDbs();
    }
  }

  followFile(file) {
    if (this.tail?.file === file) {
      return false;
    }

    this.tail = new TailReader(file, (record) => this.handleRecord(record));
    this.state = null;
    this.lastPushed = null;
    this.cancelIdle();
    try {
      this.priming = true;
      this.tail.prime();
    } catch (error) {
      log(`prime failed: ${error.message}`);
    } finally {
      this.priming = false;
    }

    try {
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs > THREAD_STALE_IDLE_MS) {
        this.state = "idle";
      }
    } catch {
      // The file may rotate while switching; the next poll will recover.
    }

    const nextState = this.state || "idle";
    this.lastPushed = nextState;
    this.queuePush(nextState);
    return true;
  }

  resetForAppExit() {
    this.closeCodexDbs();
    this.tail = null;
    this.state = null;
    this.noActiveThread = false;
    this.lastPushed = null;
    if (this.titleProcess) {
      this.titleProcess.kill();
      this.titleProcess = null;
    }
    this.titleBuffer = "";
    this.uiTitle = null;
    this.lastUiTitleAt = 0;
    this.lastUnmatchedTitle = null;
    this.cancelIdle();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  async ensureClient() {
    if (this.client?.isReady) {
      return this.client;
    }
    if (Date.now() - this.lastConnectAttempt < RECONNECT_MS) {
      return null;
    }
    this.lastConnectAttempt = Date.now();
    if (!this.config.clientId) {
      return null;
    }
    if (this.client) {
      await this.client.close().catch(() => {});
      this.client = null;
    }
    const client = new DiscordIpcClient({
      clientId: this.config.clientId,
      connectAttempts: 1,
    });
    client.on("close", () => {
      this.activityVisible = false;
    });
    try {
      await client.connect();
      this.client = client;
      log("Discord IPC connected");
      return client;
    } catch (error) {
      log(`Discord IPC connect failed: ${error.message}`);
      return null;
    }
  }

  queuePush(stateKey) {
    this.pushChain = this.pushChain
      .then(() => this.#push(stateKey))
      .catch((error) => log(`push failed: ${error.message}`));
    return this.pushChain;
  }

  async #push(stateKey) {
    const wait = 900 - (Date.now() - this.lastPushAt);
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.lastPushAt = Date.now();

    const client = await this.ensureClient();
    if (!client) {
      return;
    }
    try {
      await client.setActivity({
        type: 0,
        details: DETAILS,
        state: STATE_TEXT[stateKey],
        timestamps: { start: this.startedAt },
        instance: false,
      });
      this.activityVisible = true;
      log(`state=${stateKey}`);
    } catch (error) {
      this.activityVisible = false;
      log(`setActivity failed: ${error.message}`);
      await client.close().catch(() => {});
      if (this.client === client) {
        this.client = null;
      }
    }
  }

  setState(stateKey) {
    if (stateKey === this.state) {
      return;
    }
    this.state = stateKey;
    if (this.priming) {
      return;
    }
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const stateKey = this.state;
      if (!stateKey || stateKey === this.lastPushed) {
        return;
      }
      this.lastPushed = stateKey;
      this.queuePush(stateKey);
    }, 550);
  }

  handleRecord(record) {
    const next = stateForRecord(record);
    if (!next) {
      return;
    }

    if (next === "idle") {
      if (this.state === "answering") {
        if (this.priming) {
          this.state = "idle";
        } else {
          this.scheduleIdle(ANSWER_HOLD_MS);
        }
      } else {
        this.setState("idle");
      }
      return;
    }

    this.cancelIdle();
    this.setState(next);
  }

  scheduleIdle(delayMs) {
    this.cancelIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.setState("idle");
    }, delayMs);
  }

  cancelIdle() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  async clearActivity() {
    if (!this.client?.isReady) {
      return;
    }
    try {
      await this.client.clearActivity();
      this.activityVisible = false;
      log("activity cleared");
    } catch (error) {
      log(`clearActivity failed: ${error.message}`);
    }
  }

  async tick() {
    if (fs.existsSync(STOP_FILE)) {
      try {
        fs.unlinkSync(STOP_FILE);
      } catch {
        // Ignore cleanup failures; the watcher exits either way.
      }
      await this.stop();
      process.exit(0);
    }

    const processCheckMs = this.activityVisible
      ? APP_WINDOW_CHECK_MS
      : APP_IDLE_CHECK_MS;
    if (Date.now() - this.lastProcessCheck >= processCheckMs) {
      await this.checkAppRunning();
    }

    if (!this.appRunning) {
      if (this.activityVisible) {
        await this.clearActivity();
      }
      this.resetForAppExit();
      return;
    }

    this.startTitleWatcher();
    this.pollActiveThread();
    if (this.shouldDeferToUiTitle()) {
      this.setState("idle");
      return;
    }
    if (this.noActiveThread && this.shouldPreferUiTitle()) {
      this.setState("idle");
      return;
    }
    if (this.activeThreadId) {
      if (!this.activeRollout) {
        this.setState("idle");
        return;
      }
      if (this.followFile(this.activeRollout)) {
        return;
      }
      try {
        this.tail.poll();
      } catch (error) {
        log(`poll failed: ${error.message}`);
      }
      this.checkQuietThread();
      return;
    }

    if (this.shouldPreferUiTitle()) {
      this.setState("idle");
      return;
    }

    const latest = latestSessionFile();
    if (!latest) {
      this.setState("idle");
      return;
    }

    if (this.followFile(latest.file)) {
      return;
    }

    try {
      this.tail.poll();
    } catch (error) {
      log(`poll failed: ${error.message}`);
    }
    this.checkQuietThread();
  }

  checkQuietThread() {
    if (!this.activeRollout) {
      return;
    }
    const now = Date.now();
    if (now - this.lastQuietCheck < APP_WINDOW_CHECK_MS) {
      return;
    }
    this.lastQuietCheck = now;
    try {
      const stat = fs.statSync(this.activeRollout);
      if (now - stat.mtimeMs > THREAD_QUIET_IDLE_MS && this.state !== "idle") {
        this.setState("idle");
      }
    } catch {
      // Missing files are handled on the next tick.
    }
  }

  async run() {
    if (!this.config.clientId) {
      log("no clientId configured; watcher exiting");
      process.exit(0);
    }

    log(`watcher started pid=${process.pid} client=${this.config.clientId.slice(-4)}`);
    this.startTitleWatcher();
    await this.ensureClient();

    while (!this.stopping) {
      try {
        await this.tick();
      } catch (error) {
        log(`tick failed: ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  async stop() {
    this.stopping = true;
    this.cancelIdle();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.titleProcess) {
      this.titleProcess.kill();
      this.titleProcess = null;
    }
    await this.clearActivity();
    await this.client?.close().catch(() => {});
    this.client = null;
    try {
      fs.unlinkSync(PID_FILE);
    } catch {
      // The PID file may already be gone.
    }
    log("watcher stopped");
  }
}

function alreadyRunning() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
    if (!pid || pid === process.pid) {
      return false;
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (alreadyRunning()) {
  process.exit(0);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(PID_FILE, `${process.pid}\n`);

const live = new LivePresence();
process.once("SIGINT", () => live.stop().finally(() => process.exit(0)));
process.once("SIGTERM", () => live.stop().finally(() => process.exit(0)));
process.once("uncaughtException", (error) => {
  log(`uncaught: ${error.stack || error.message}`);
});

live.run().catch((error) => {
  log(`fatal: ${error.stack || error.message}`);
  process.exit(1);
});
