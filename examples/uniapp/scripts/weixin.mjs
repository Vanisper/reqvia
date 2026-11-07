import WebSocket from "ws";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { once } from "node:events";

export async function openWeixin(automation = false) {
  const appid = process.env.WEIXIN_APPID;
  if (!appid || !/^wx[0-9a-f]{16}$/i.test(appid)) {
    throw new Error("请通过 WEIXIN_APPID 显式提供自己可使用的微信小程序 AppID");
  }
  const project = fileURLToPath(new URL("../dist/build/mp-weixin/", import.meta.url));
  const configPath = new URL("../dist/build/mp-weixin/project.config.json", import.meta.url);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  // 仅修改被忽略的本地产物，源配置不保存账号标识
  await writeFile(configPath, `${JSON.stringify({ ...config, appid }, null, 2)}\n`);
  const cli =
    process.env.WEIXIN_DEVTOOLS_CLI || "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";
  const port = Number(process.env.WEIXIN_AUTOMATION_PORT || 9421);
  const args = automation
    ? ["auto", "--project", project, "--auto-port", String(port), "--trust-project"]
    : ["open", "--project", project];
  const result = await promisify(execFile)(cli, args, { timeout: 60_000 });
  if (/APPID_ERROR|\[error\]/.test(result.stdout + result.stderr)) {
    throw new Error(`微信开发者工具加载失败：${result.stderr}${result.stdout}`);
  }
  return port;
}

// 协议字段与微信官方 miniprogram-automator 的 Connection / Page / Element 保持一致
export async function connectWeixin(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.on("error", () => {});
  try {
    await once(socket, "open", { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    socket.terminate();
    throw error;
  }
  let nextId = 0;
  const pending = new Map();
  const rejectPending = () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("微信自动化连接已关闭"));
    }
    pending.clear();
  };
  socket.addEventListener("close", rejectPending);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timeout);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) {
        reject(new Error("微信自动化连接未打开"));
        return;
      }
      const id = String(++nextId);
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`微信自动化超时：${method}`));
      }, 10_000);
      pending.set(id, { resolve, reject, timeout });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        pending.delete(id);
        clearTimeout(timeout);
        reject(error);
      }
    });
  return {
    send,
    async close() {
      rejectPending();
      if (socket.readyState === WebSocket.CLOSED) return;
      const closed = once(socket, "close");
      const force = setTimeout(() => socket.terminate(), 1_000);
      socket.close();
      // 远端不完成关闭握手时主动释放 TCP 句柄
      try {
        await closed;
      } finally {
        clearTimeout(force);
      }
    },
  };
}
