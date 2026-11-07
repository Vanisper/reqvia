import { request as uniRequest } from "@dcloudio/uni-h5";
import { fromAbortSignal } from "@reqvia/compat-abort";
import { createFetchTransport } from "@reqvia/transport-fetch";
import { createUniTransport } from "@reqvia/transport-uni";
import {
  bytes,
  bytesBody,
  createHttpClient,
  empty,
  isHttpError,
  json,
  text,
  textBody,
} from "reqvia";
import type { CallOptions, HttpError, HttpExecutor, Transport } from "reqvia";
import type { UniTransportOptions } from "@reqvia/transport-uni";
import "./style.css";

interface User {
  id: string;
  name: string;
}

interface CheckResult {
  transport: string;
  name: string;
  passed: boolean;
  detail?: string;
}

interface VerificationResult {
  passed: boolean;
  checks: CheckResult[];
  userAgent: string;
}

declare global {
  var __uniConfig: { networkTimeout: { request: number } };
  var __reqviaVerification: Promise<VerificationResult>;
}

function parseUser(value: unknown): User {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("name" in value) ||
    typeof value.name !== "string"
  ) {
    throw new TypeError("用户响应格式无效");
  }
  return { id: value.id, name: value.name };
}

class UserService {
  private readonly http: HttpExecutor;

  constructor(http: HttpExecutor) {
    this.http = http;
  }

  async find(id: string, options?: CallOptions): Promise<User> {
    const { data } = await this.http.request(
      { url: `users/${encodeURIComponent(id)}` },
      json(parseUser),
      options,
    );
    return data;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectError(pending: Promise<unknown>, kind: HttpError["kind"]): Promise<HttpError> {
  try {
    await pending;
  } catch (error) {
    assert(isHttpError(error), `预期 ${kind}，得到非 Reqvia 错误`);
    assert(error.kind === kind, `预期 ${kind}，得到 ${error.kind}`);
    return error;
  }
  throw new Error(`预期 ${kind}，请求却成功`);
}

async function waitForState(id: string, field: "opened" | "aborted"): Promise<void> {
  const deadline = performance.now() + 4_000;
  while (performance.now() < deadline) {
    const response = await fetch(`/__state?id=${encodeURIComponent(id)}`);
    const state: unknown = await response.json();
    if (typeof state === "object" && state !== null) {
      if (field === "opened" && "opened" in state && state.opened === true) return;
      if (field === "aborted" && "aborted" in state && state.aborted === true) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`服务端未观察到 ${id} 的 ${field} 状态`);
}

async function run(): Promise<VerificationResult> {
  // 仅提供官方请求运行时读取的配置，不启动 Uni 页面或编译器
  globalThis.__uniConfig = { networkTimeout: { request: 5_000 } };
  const uniOptions: UniTransportOptions = {
    request: uniRequest,
    capabilities: {
      methods: ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"],
      requestBytes: true,
      responseBytes: true,
    },
  };
  const transports: Array<readonly [string, Transport]> = [
    ["Fetch", createFetchTransport({ fetch, createAbortController: () => new AbortController() })],
    ["Uni H5", createUniTransport(uniOptions)],
  ];
  const checks: CheckResult[] = [];
  const rows = document.querySelector<HTMLTableSectionElement>("#results")!;

  for (const [name, transport] of transports) {
    const http = createHttpClient({
      transport,
      baseURL: `${location.origin}/api/`,
      timeoutMs: 5_000,
    });
    const service = new UserService(http);
    const check = async (title: string, action: () => Promise<void>) => {
      const result: CheckResult = { transport: name, name: title, passed: true };
      try {
        await action();
      } catch (error) {
        result.passed = false;
        result.detail = error instanceof Error ? error.message : String(error);
      }
      checks.push(result);
      const row = rows.insertRow();
      for (const value of [name, title, result.passed ? "通过" : result.detail!]) {
        row.insertCell().textContent = value;
      }
      row.className = result.passed ? "pass" : "fail";
    };

    await check("同一 Service 校验 JSON", async () => {
      const user = await service.find("42");
      assert(user.id === "42" && user.name === "林舟", "Service 返回值不同");
    });
    await check("JSON 原文保持文本", async () => {
      const response = await http.request({ url: "users/42" }, text());
      assert(response.data === '{"id":"42","name":"林舟"}', "平台提前解析或修改了文本");
    });
    await check("中文文本正文往返", async () => {
      const response = await http.request(
        { url: "echo", method: "POST", body: textBody("你好，Reqvia") },
        text(),
      );
      assert(response.data === "你好，Reqvia", "中文文本内容不同");
    });
    await check("字节切片正文往返", async () => {
      const source = new Uint8Array([99, 0, 128, 255, 1, 98]);
      const response = await http.request(
        { url: "echo", method: "POST", body: bytesBody(source.subarray(1, 5)) },
        bytes(),
      );
      assert([...response.data].join(",") === "0,128,255,1", "字节正文发生变化或包含切片外数据");
    });
    await check("204 空响应", async () => {
      const response = await http.request({ url: "empty" }, empty());
      assert(response.status === 204 && response.data === null, "空响应契约不一致");
    });
    await check("404 保留状态与正文", async () => {
      const error = await expectError(http.request({ url: "missing" }, text()), "STATUS");
      assert(error.kind === "STATUS", "未返回状态错误");
      assert(error.response.status === 404, "状态码未保留");
      assert(
        error.response.payload.kind === "text" && error.response.payload.value === "not found",
        "失败正文未保留",
      );
    });
    await check("损坏 JSON 归类为 DECODE", async () => {
      await expectError(http.request({ url: "bad-json" }, json()), "DECODE");
    });
    await check("正文中途断连归类为 TRANSPORT", async () => {
      await expectError(http.request({ url: "disconnect" }, text()), "TRANSPORT");
    });
    await check("原生信号取消并停止慢正文", async () => {
      const id = `${name}-cancel`;
      const controller = new AbortController();
      const binding = fromAbortSignal(controller.signal);
      try {
        const pending = expectError(
          http.request({ url: "slow", query: { id } }, text(), {
            cancellation: binding.cancellation,
          }),
          "CANCELLED",
        );
        await waitForState(id, "opened");
        controller.abort("leave page");
        const error = await pending;
        assert(error.kind === "CANCELLED" && error.reason === "leave page", "取消原因未保留");
        await waitForState(id, "aborted");
      } finally {
        binding.dispose();
      }
    });
    await check("总超时停止慢正文", async () => {
      const id = `${name}-timeout`;
      await expectError(
        http.request({ url: "slow", query: { id } }, bytes(), { timeoutMs: 250 }),
        "TIMEOUT",
      );
      await waitForState(id, "aborted");
    });
  }

  const result = {
    passed: checks.every((check) => check.passed),
    checks,
    userAgent: navigator.userAgent,
  };
  document.querySelector("#status")!.textContent =
    `${checks.filter((check) => check.passed).length} / ${checks.length} 项通过`;
  return result;
}

globalThis.__reqviaVerification = run();
