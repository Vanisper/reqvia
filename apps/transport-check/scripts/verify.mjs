import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiHandler } from "./server.mjs";

const app = fileURLToPath(new URL("../", import.meta.url));
const dist = join(app, "dist");
const handleApi = createApiHandler();
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

async function findChrome() {
  const candidates = process.env.CHROME_BIN
    ? [process.env.CHROME_BIN]
    : [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ...["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].flatMap(
          (name) =>
            (process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, name)),
        ),
        ...[process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
          .filter(Boolean)
          .map((directory) => join(directory, "Google", "Chrome", "Application", "chrome.exe")),
      ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 按候选顺序查找，CHROME_BIN 显式设置时只检查该入口
    }
  }
  throw new Error("未找到 Chrome/Chromium；设置 CHROME_BIN 为可执行文件的绝对路径后重试");
}

async function serve(request, response) {
  if (await handleApi(request, response)) return;
  const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
  const filename = resolve(dist, pathname === "/" ? "index.html" : `.${pathname}`);
  if (!filename.startsWith(`${dist}${sep}`)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const content = await readFile(filename);
    response.setHeader("content-type", mime[extname(filename)] ?? "application/octet-stream");
    response.end(content);
  } catch {
    response.writeHead(404).end();
  }
}

function waitForDebugger(browser) {
  return new Promise((resolveReady, reject) => {
    let output = "";
    const timer = setTimeout(() => finish(new Error("Chrome 调试端口启动超时")), 15_000);
    const finish = (error, url) => {
      clearTimeout(timer);
      browser.stderr.off("data", read);
      browser.off("error", failed);
      browser.off("exit", exited);
      if (error) reject(error);
      else resolveReady(url);
    };
    const read = (chunk) => {
      output += String(chunk);
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) finish(undefined, match[1]);
    };
    const failed = (error) => finish(error);
    const exited = (code) => finish(new Error(`Chrome 提前退出（${code}）：${output}`));
    browser.stderr.on("data", read);
    browser.once("error", failed);
    browser.once("exit", exited);
  });
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const events = new Map();
  const exceptions = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.exceptionThrown")
      exceptions.push(message.params.exceptionDetails);
    const waiting = events.get(message.method);
    if (waiting) {
      clearTimeout(waiting.timer);
      events.delete(message.method);
      waiting.resolve(message.params);
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Chrome 调试连接已关闭"));
    }
    pending.clear();
    for (const entry of events.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Chrome 调试连接已关闭"));
    }
    events.clear();
  });
  return {
    socket,
    exceptions,
    wait(method) {
      return new Promise((resolveEvent, reject) => {
        const timer = setTimeout(() => {
          events.delete(method);
          reject(new Error(`浏览器事件超时：${method}`));
        }, 15_000);
        events.set(method, { resolve: resolveEvent, reject, timer });
      });
    },
    call(method, params = {}) {
      return new Promise((resolveCall, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`浏览器调用超时：${method}`));
        }, 30_000);
        pending.set(id, { resolve: resolveCall, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

const chrome = await findChrome();
await access(join(dist, "index.html"));
const profile = await mkdtemp(join(tmpdir(), "reqvia-chrome-"));
const server = createServer((request, response) => {
  void serve(request, response).catch((error) => response.destroy(error));
});
let browser;
let browserClosed;
let connection;

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  browser = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-background-networking",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  browserClosed = new Promise((resolveClosed) => browser.once("close", resolveClosed));
  const debuggerUrl = new URL(await waitForDebugger(browser));
  const pages = await (await fetch(`http://${debuggerUrl.host}/json/list`)).json();
  const page = pages.find((target) => target.type === "page");
  assert.ok(page, "Chrome 未创建页面目标");
  connection = await connect(page.webSocketDebuggerUrl);
  await connection.call("Runtime.enable");
  await connection.call("Page.enable");
  const loaded = connection.wait("Page.loadEventFired");
  await connection.call("Page.navigate", { url });
  await loaded;
  // 页面入口先创建验证 Promise，再等待实际网络用例；不使用虚拟时间加速超时
  const evaluation = await connection.call("Runtime.evaluate", {
    expression: `(async () => {
      const deadline = performance.now() + 10000;
      while (!globalThis.__reqviaVerification) {
        if (performance.now() >= deadline) throw new Error("页面验证未启动");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return await globalThis.__reqviaVerification;
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  assert.ok(!evaluation.exceptionDetails, JSON.stringify(evaluation.exceptionDetails));
  const result = evaluation.result.value;
  assert.ok(result && result.checks.length === 20, "未取得完整验证结果");
  for (const check of result.checks) {
    if (!check.passed) console.error(`${check.transport} / ${check.name}: ${check.detail}`);
  }
  assert.equal(result.passed, true, "传输验证失败");
  assert.equal(connection.exceptions.length, 0, JSON.stringify(connection.exceptions));
  const version = await connection.call("Browser.getVersion");
  console.log(
    `浏览器验证通过：20 项，${version.product}，Node ${process.version}，${process.platform}/${process.arch}`,
  );
  console.log(
    "官方 Uni H5 请求运行时 3.0.0-alpha-5030620261106001；Fetch 与 Uni 均观察到服务端连接提前关闭",
  );
} finally {
  connection?.socket.close();
  if (browser && browser.exitCode === null) browser.kill();
  if (browserClosed) await browserClosed;
  server.closeAllConnections();
  if (server.listening) await new Promise((resolveClosed) => server.close(resolveClosed));
  await rm(profile, { recursive: true, force: true });
}
