import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/** 本地示例验收所需的浏览器操作 */
export interface BrowserPage {
  /** 在页面上下文求值并等待 Promise，只接收可序列化结果 */
  evaluate<T = unknown>(expression: string): Promise<T>;
  /** 等待表达式为真；超时包含表达式以便定位失败 */
  waitFor(expression: string, timeoutMs?: number): Promise<void>;
  /** 通过页面 DOM 触发点击 */
  click(selector: string): Promise<void>;
  /** 修改输入框并发出 input 和 change 事件 */
  fill(selector: string, value: string): Promise<void>;
  /** 已观察到的未处理页面异常 */
  readonly exceptions: readonly unknown[];
}

async function findChrome(): Promise<string> {
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
          .filter((value): value is string => Boolean(value))
          .map((directory) => join(directory, "Google", "Chrome", "Application", "chrome.exe")),
      ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 显式 CHROME_BIN 只检查指定入口，默认按平台候选顺序查找
    }
  }
  throw new Error("未找到 Chrome/Chromium，请用 CHROME_BIN 指定可执行文件");
}

function waitForDebugger(browser: ChildProcess): Promise<string> {
  return new Promise((resolveReady, reject) => {
    let output = "";
    const timer = setTimeout(() => finish(new Error("Chrome 启动超时")), 15_000);
    const finish = (error?: Error, url?: string) => {
      clearTimeout(timer);
      browser.stderr?.off("data", read);
      browser.off("error", failed);
      browser.off("exit", exited);
      if (error) reject(error);
      else resolveReady(url!);
    };
    const read = (chunk: Buffer) => {
      output += String(chunk);
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) finish(undefined, match[1]);
    };
    const failed = (error: Error) => finish(error);
    const exited = (code: number | null) => finish(new Error(`Chrome 提前退出 ${code}：${output}`));
    browser.stderr?.on("data", read);
    browser.once("error", failed);
    browser.once("exit", exited);
  });
}

interface ProtocolReply {
  id?: number;
  method?: string;
  result?: unknown;
  error?: unknown;
  params?: unknown;
}

async function connect(url: string) {
  const socket = new WebSocket(url);
  await new Promise<void>((resolveOpen, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Chrome 调试连接超时"));
    }, 10_000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolveOpen();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("Chrome 调试连接失败"));
      },
      { once: true },
    );
  });
  let nextId = 0;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const exceptions: unknown[] = [];
  const events = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as ProtocolReply;
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params);
    const waiting = message.method === undefined ? undefined : events.get(message.method);
    if (waiting) {
      clearTimeout(waiting.timer);
      events.delete(message.method!);
      waiting.resolve();
    }
    if (message.id === undefined) return;
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
      entry.reject(new Error("浏览器调试连接已关闭"));
    }
    pending.clear();
    for (const entry of events.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("浏览器调试连接已关闭"));
    }
    events.clear();
  });
  return {
    socket,
    exceptions,
    wait(method: string): Promise<void> {
      return new Promise((resolveEvent, reject) => {
        const timer = setTimeout(() => {
          events.delete(method);
          reject(new Error(`浏览器事件超时：${method}`));
        }, 15_000);
        events.set(method, { resolve: resolveEvent, reject, timer });
      });
    },
    async call<T = unknown>(method: string, params: object = {}): Promise<T> {
      return await new Promise((resolveCall, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`浏览器调用超时：${method}`));
        }, 30_000);
        pending.set(id, { resolve: (value) => resolveCall(value as T), reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

/**
 * 在独立临时 Chrome 中执行示例验收并清理进程
 *
 * @description 使用真实时钟；不读取用户浏览器配置，任一未处理页面异常使验收失败
 */
export async function withBrowser<T>(
  url: string,
  verify: (page: BrowserPage) => Promise<T>,
): Promise<T> {
  const chrome = await findChrome();
  const profile = await mkdtemp(join(tmpdir(), "reqvia-consumer-chrome-"));
  let browser: ChildProcess | undefined;
  let closed: Promise<void> | undefined;
  let connection: Awaited<ReturnType<typeof connect>> | undefined;
  try {
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
    closed = new Promise((resolveClosed) => browser!.once("close", () => resolveClosed()));
    const debuggerUrl = new URL(await waitForDebugger(browser));
    const targets = (await (
      await fetch(`http://${debuggerUrl.host}/json/list`, { signal: AbortSignal.timeout(5_000) })
    ).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const target = targets.find((entry) => entry.type === "page");
    if (!target) throw new Error("Chrome 未创建页面");
    connection = await connect(target.webSocketDebuggerUrl);
    const protocol = connection;
    await protocol.call("Runtime.enable");
    await protocol.call("Page.enable");
    await Promise.all([
      protocol.wait("Page.loadEventFired"),
      protocol.call("Page.navigate", { url }),
    ]);
    const page: BrowserPage = {
      exceptions: protocol.exceptions,
      async evaluate<TValue>(expression: string): Promise<TValue> {
        const result = await protocol.call<{
          result: { value: TValue };
          exceptionDetails?: unknown;
        }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      },
      async waitFor(expression, timeoutMs = 5_000) {
        await page.evaluate(`(async () => {
          const deadline = performance.now() + ${JSON.stringify(timeoutMs)};
          while (!(${expression})) {
            if (performance.now() >= deadline) throw new Error(${JSON.stringify(`等待页面条件超时：${expression}`)});
            await new Promise(resolve => setTimeout(resolve, 20));
          }
        })()`);
      },
      async click(selector) {
        await page.evaluate(
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('元素不存在'); el.click(); })()`,
        );
      },
      async fill(selector, value) {
        await page.evaluate(
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('输入框不存在'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`,
        );
      },
    };
    await page.waitFor("document.readyState === 'complete' && location.href !== 'about:blank'");
    const result = await verify(page);
    if (protocol.exceptions.length)
      throw new Error(`页面出现未处理异常：${JSON.stringify(protocol.exceptions)}`);
    return result;
  } finally {
    connection?.socket.close();
    if (browser && browser.exitCode === null) {
      browser.kill();
      const killer = setTimeout(() => browser?.kill("SIGKILL"), 3_000);
      await closed;
      clearTimeout(killer);
    }
    await rm(profile, { recursive: true, force: true });
  }
}
