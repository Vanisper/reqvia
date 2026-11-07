import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const manager = manifest.devEngines.packageManager;
const packageManager = `${manager.name}@${manager.version}`;
// vp task 会把项目内 CLI 放到 PATH 前面，环境管理需要使用父进程提供的全局入口
const viteCLI = process.env.VP_CLI_BIN ?? "vp";
const temporary = await mkdtemp(join(tmpdir(), "reqvia-consumer-"));
const consumer = join(temporary, "consumer");
const compiler = join(root, "packages/reqvia/node_modules/.bin/tsc");

function run(command, args, cwd, timeout = 60_000) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CI: "true" },
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error.stdout) process.stderr.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
  }
}

function pnpm(args, cwd) {
  return run(
    viteCLI,
    ["env", "exec", "--package-manager", packageManager, "--", "pnpm", ...args],
    cwd,
  );
}

async function writeJSON(name, value) {
  await writeFile(join(consumer, name), `${JSON.stringify(value, null, 2)}\n`);
}

const serviceSource = `import { json } from "reqvia";
import type { CallOptions, HttpExecutor } from "reqvia";

export interface User {
  id: string;
  name: string;
}

export function parseUser(value: unknown): User {
  if (typeof value !== "object" || value === null ||
      !("id" in value) || typeof value.id !== "string" ||
      !("name" in value) || typeof value.name !== "string") {
    throw new TypeError("用户响应格式无效");
  }
  return { id: value.id, name: value.name };
}

export class UserService {
  constructor(private readonly http: HttpExecutor) {}

  async find(id: string, options?: CallOptions): Promise<User> {
    const { data } = await this.http.request(
      { url: "users/" + encodeURIComponent(id) }, json(parseUser), options,
    );
    return data;
  }
}
`;

const coreProbe = `import { createCancellation, json } from "reqvia";
import type { CallOptions, HttpExecutor } from "reqvia";
import { parseUser, UserService } from "./service.js";
import type { User } from "./service.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
declare const http: HttpExecutor;

const unknownResponse = http.request({ url: "users/42" }, json());
type UnknownResult = Assert<Equal<Awaited<typeof unknownResponse>["data"], unknown>>;
const userResponse = http.request({ url: "users/42" }, json(parseUser));
type UserResult = Assert<Equal<Awaited<typeof userResponse>["data"], User>>;
const asyncResponse = http.request({ url: "users/42" }, json(async (value) => parseUser(value).id));
type AsyncResult = Assert<Equal<Awaited<typeof asyncResponse>["data"], string>>;
const serviceResponse = new UserService(http).find("42");
type ServiceResult = Assert<Equal<Awaited<typeof serviceResponse>, User>>;

const source = createCancellation();
const options: CallOptions = { cancellation: source.cancellation, timeoutMs: undefined };
// @ts-expect-error 取消源不能替代只读取消状态
const invalidOptions: CallOptions = { cancellation: source };
// @ts-expect-error 业务类型必须来自实际校验函数
json<User>();
export type Results = [UnknownResult, UserResult, AsyncResult, ServiceResult];
void options;
void invalidOptions;
`;

const fetchProbe = `import { createFetchTransport } from "@reqvia/transport-fetch";
import type { FetchTransportOptions } from "@reqvia/transport-fetch";
import type { Transport } from "reqvia";

const options: FetchTransportOptions = {
  fetch,
  createAbortController: () => new AbortController(),
};
const transport: Transport = createFetchTransport(options);
void transport;
`;

const runtimeSource = `import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createHttpClient, createHeaderFields } from "reqvia";
import { createFetchTransport } from "@reqvia/transport-fetch";
import { UserService } from "./compiled/service.js";

const expected = { id: "42", name: "林舟" };
let memoryCalls = 0;
const memory = new UserService(createHttpClient({
  baseURL: "https://memory.example/v1/",
  transport: {
    async send(request) {
      memoryCalls++;
      assert.equal(request.url, "https://memory.example/v1/users/42");
      assert.equal(request.representation, "text");
      return {
        status: 200,
        headers: createHeaderFields([["Content-Type", "application/json"]]),
        payload: { kind: "text", value: JSON.stringify(expected) },
      };
    },
  },
}));

let networkCalls = 0;
const server = createServer((request, response) => {
  networkCalls++;
  response.writeHead(request.url === "/v1/users/42" ? 200 : 404, {
    "content-type": "application/json;charset=UTF-8",
  });
  response.end(JSON.stringify(expected));
});

try {
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const network = new UserService(createHttpClient({
    baseURL: "http://127.0.0.1:" + address.port + "/v1/",
    timeoutMs: 2_000,
    transport: createFetchTransport({
      fetch,
      createAbortController: () => new AbortController(),
    }),
  }));
  assert.deepEqual(await memory.find("42"), expected);
  assert.deepEqual(await network.find("42"), expected);
  assert.equal(memoryCalls, 1);
  assert.equal(networkCalls, 1);
} finally {
  if (server.listening) {
    const closed = new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    server.closeAllConnections();
    await closed;
  }
}
`;

try {
  await mkdir(consumer);
  const dependencies = {};
  for (const [directory, name, filename] of [
    ["reqvia", "reqvia", "reqvia.tgz"],
    ["transport-fetch", "@reqvia/transport-fetch", "transport-fetch.tgz"],
  ]) {
    const archive = join(temporary, filename);
    pnpm(["pack", "--out", archive], join(root, "packages", directory));
    dependencies[name] = pathToFileURL(archive).href;
  }
  await writeJSON("package.json", {
    name: "reqvia-package-consumer",
    private: true,
    type: "module",
    dependencies,
  });
  pnpm(["install", "--offline", "--ignore-scripts", "--no-frozen-lockfile"], consumer);

  // 从安装目录解析入口，防止工作区链接意外代替了打包产物
  for (const name of Object.keys(dependencies)) {
    const installed = await realpath(join(consumer, "node_modules", name));
    assert.ok(!installed.startsWith(`${resolve(root, "packages")}/`));
    const packed = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
    assert.equal(packed.name, name);
    for (const version of Object.values(packed.peerDependencies ?? {})) {
      assert.ok(!version.startsWith("workspace:"), "打包后仍含 workspace peer 依赖");
    }
  }

  await Promise.all([
    writeFile(join(consumer, "service.ts"), serviceSource),
    writeFile(join(consumer, "core-probe.ts"), coreProbe),
    writeFile(join(consumer, "fetch-probe.ts"), fetchProbe),
    writeFile(join(consumer, "runtime.mjs"), runtimeSource),
  ]);
  await writeJSON("tsconfig.core.json", {
    compilerOptions: {
      target: "ES2023",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2023"],
      types: [],
      strict: true,
      exactOptionalPropertyTypes: true,
      skipLibCheck: false,
      verbatimModuleSyntax: true,
      outDir: "compiled",
    },
    files: ["service.ts", "core-probe.ts"],
  });
  await writeJSON("tsconfig.fetch.json", {
    extends: "./tsconfig.core.json",
    compilerOptions: { lib: ["ES2023", "DOM", "DOM.Iterable"], noEmit: true },
    files: ["fetch-probe.ts"],
  });
  run(compiler, ["-p", "tsconfig.core.json"], consumer);
  run(compiler, ["-p", "tsconfig.fetch.json"], consumer);
  run(process.execPath, ["runtime.mjs"], consumer, 15_000);
  console.log(
    `打包产物验证通过（Node ${process.version}）：独立离线安装、核心纯 ES 类型、Fetch 类型与 Service 双传输消费`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
