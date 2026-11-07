import { fromAbortSignal } from "@reqvia/compat-abort";
import { DomainValidationError, UserService } from "@reqvia/example-domain";
import { startExampleServer } from "@reqvia/example-server";
import { createFetchTransport } from "@reqvia/transport-fetch";
import { createHttpClient, isHttpError } from "reqvia";

const help = `Reqvia 用户查询示例

用法：
  list [--query 关键词] [--timeout-ms 毫秒] [--base-url API地址]
  find 用户ID [--timeout-ms 毫秒] [--base-url API地址]

默认启动本地示例服务，结果以 JSON 写入标准输出。
--timeout-ms 默认 5000，0 关闭 Reqvia 的超时预算。
Ctrl+C 取消请求并释放本地资源。

示例：
  list
  find 42
  list --query invalid
  list --query hang --timeout-ms 200
`;

interface Command {
  kind: "list" | "find";
  value: string;
  timeoutMs: number;
  baseURL?: string;
}

class UsageError extends Error {}

function parseArgs(input: string[]): Command | undefined {
  // vp run 会保留参数分隔符，直接运行 Node 时可以省略
  const args = input[0] === "--" ? input.slice(1) : input;
  if (args.includes("--help") || args.includes("-h")) return;
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    if (!["--query", "--timeout-ms", "--base-url"].includes(argument)) {
      throw new UsageError(`未知参数：${argument}`);
    }
    if (flags.has(argument)) throw new UsageError(`重复参数：${argument}`);
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${argument} 缺少值`);
    }
    flags.set(argument, value);
  }
  const kind = positional[0] ?? "list";
  if (kind !== "list" && kind !== "find") throw new UsageError(`未知命令：${kind}`);
  if (kind === "find" && (!positional[1] || flags.has("--query"))) {
    throw new UsageError("find 需要用户 ID，且不接受 --query");
  }
  if (positional.length > (kind === "find" ? 2 : 1)) {
    throw new UsageError("命令包含多余的位置参数");
  }
  const timeoutInput = flags.get("--timeout-ms");
  const timeoutMs = timeoutInput === undefined ? 5_000 : Number(timeoutInput);
  if (timeoutInput?.trim() === "" || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new UsageError("--timeout-ms 必须为非负有限数字");
  }
  const baseURL = flags.get("--base-url");
  if (baseURL?.trim() === "") throw new UsageError("--base-url 不能为空");
  return {
    kind,
    value: kind === "find" ? positional[1] : (flags.get("--query") ?? ""),
    timeoutMs,
    ...(baseURL === undefined ? {} : { baseURL }),
  };
}

async function execute(command: Command): Promise<void> {
  const controller = new AbortController();
  const interrupt = () => controller.abort("SIGINT");
  const terminate = () => controller.abort("SIGTERM");
  const binding = fromAbortSignal(controller.signal);
  let server: Awaited<ReturnType<typeof startExampleServer>> | undefined;
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);

  try {
    if (command.baseURL === undefined) server = await startExampleServer({});
    const http = createHttpClient({
      baseURL: command.baseURL ?? server!.baseURL,
      timeoutMs: command.timeoutMs,
      transport: createFetchTransport({
        fetch,
        createAbortController: () => new AbortController(),
      }),
    });
    const users = new UserService(http);
    const options = { cancellation: binding.cancellation };
    const result =
      command.kind === "find"
        ? await users.find(command.value, options)
        : await users.list(command.value, options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    binding.dispose();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    // 等待清理完成后让事件循环自然退出，不用 process.exit 截断资源释放
    await server?.close();
  }
}

try {
  const command = parseArgs(process.argv.slice(2));
  if (command) await execute(command);
  else process.stdout.write(help);
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`参数错误：${error.message}\n使用 --help 查看用法\n`);
    process.exitCode = 2;
  } else if (error instanceof DomainValidationError) {
    process.stderr.write(`DOMAIN: ${error.message}\n`);
    process.exitCode = 1;
  } else if (isHttpError(error)) {
    const detail = error.kind === "CANCELLED" ? String(error.reason) : error.message;
    process.stderr.write(`${error.kind}: ${detail}\n`);
    process.exitCode =
      error.kind === "CANCELLED"
        ? error.reason === "SIGTERM"
          ? 143
          : 130
        : error.kind === "TIMEOUT"
          ? 124
          : error.kind === "CONFIG"
            ? 2
            : 1;
  } else {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
