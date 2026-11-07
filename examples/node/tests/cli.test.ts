import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished, test } from "vite-plus/test";

const executable = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));

function launch(args: string[]) {
  const child = spawn(process.execPath, [executable, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const finished = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI 未按期退出：${stderr}`));
    }, 4_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await finished.catch(() => {});
  });
  return { child, finished };
}

async function hangingServer() {
  const opened = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write("[");
    response.once("close", closed.resolve);
    opened.resolve();
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("示例服务未分配端口");
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    baseURL: `http://127.0.0.1:${address.port}/api/`,
    opened: opened.promise,
    closed: closed.promise,
  };
}

test("默认命令从本地服务取得列表并自然退出", async () => {
  const result = await launch([]).finished;
  expect(result.code).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "42", name: "林舟", role: expect.any(String) }),
      expect.objectContaining({ id: "43", name: "陈希", role: expect.any(String) }),
    ]),
  );
});

test("详情命令使用相同领域 Service", async () => {
  const result = await launch(["--", "find", "42"]).finished;
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ id: "42", name: "林舟" });
});

test("领域校验错误通过标准错误输出和非零状态交付", async () => {
  const result = await launch(["list", "--query", "invalid"]).finished;
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/^DOMAIN:/);
  expect(result.stderr).not.toContain("TRANSPORT");
});

test("HTTP 失败保留 STATUS 分类", async () => {
  const result = await launch(["list", "--query", "error"]).finished;
  expect(result.code).toBe(1);
  expect(result.stderr).toMatch(/^STATUS:/);
});

test("参数无效时不启动请求", async () => {
  const result = await launch(["list", "--timeout-ms", "-1"]).finished;
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("非负有限数字");
  expect(result.stdout).toBe("");
});

test("帮助命令无需启动服务", async () => {
  const result = await launch(["--help"]).finished;
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Ctrl+C");
  expect(result.stderr).toBe("");
});

test("总超时结束 CLI 并关闭尚未读完的连接", async () => {
  const server = await hangingServer();
  const execution = launch(["list", "--base-url", server.baseURL, "--timeout-ms", "1000"]);
  await server.opened;
  const result = await execution.finished;
  expect(result.code).toBe(124);
  expect(result.signal).toBeNull();
  expect(result.stderr).toMatch(/^TIMEOUT:/);
  await server.closed;
});

test.skipIf(process.platform === "win32")("SIGINT 经取消桥接结束请求并自然退出", async () => {
  const server = await hangingServer();
  const execution = launch(["list", "--base-url", server.baseURL, "--timeout-ms", "0"]);
  await server.opened;
  expect(execution.child.kill("SIGINT")).toBe(true);
  const result = await execution.finished;
  expect(result.code).toBe(130);
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe("CANCELLED: SIGINT\n");
  await server.closed;
});

test("默认自建服务也会在超时后清理", async () => {
  const result = await launch(["list", "--query", "hang", "--timeout-ms", "150"]).finished;
  expect(result.code).toBe(124);
  expect(result.signal).toBeNull();
  expect(result.stderr).toMatch(/^TIMEOUT:/);
});
