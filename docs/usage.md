# 使用方式

业务代码通过 `HttpExecutor` 调用接口；客户端与平台适配器在应用初始化处组装。核心、Fetch、UniApp 与取消桥接示例使用已实现的 API，完整行为见[公共契约](contracts.md)。

## 组装客户端

```ts
import { createFetchTransport } from "@reqvia/transport-fetch";
import { createHttpClient } from "reqvia";

const http = createHttpClient({
  baseURL: "https://api.example.com/v1/",
  timeoutMs: 10_000,
  headers: { accept: "application/json" },
  transport: createFetchTransport({
    fetch,
    createAbortController: () => new AbortController(),
  }),
});
```

Fetch 和取消控制器由应用明确提供。UniApp 应用在同一组装位置使用对应适配器；Service 代码保持对 `HttpExecutor` 的依赖。

`baseURL` 遵循标准相对地址规则。上述配置中的 `users/42` 指向 `/v1/users/42`；若写成 `/users/42`，则指向站点根目录下的 `/users/42`。

配置复用可以使用 `derive()`：

```ts
const reportsHttp = http.derive({
  timeoutMs: 30_000,
  headers: { accept: "text/csv" },
});
```

派生客户端复用 Transport，并保存独立默认配置。认证会随会话变化时，在应用的会话边界重新组装或绑定执行器；不把可变 token 固定在长期共享的客户端默认头中。

## 使用 UniApp 请求器

在 UniApp 应用中，把回调式 `uni.request` 注入适配器，并声明当前目标端允许的能力。下面的能力配置用于 H5 请求运行时：

```ts
import { createUniTransport } from "@reqvia/transport-uni";

const uniHttp = createHttpClient({
  baseURL: "https://api.example.com/v1/",
  transport: createUniTransport({
    request: (options) => uni.request(options),
    capabilities: {
      methods: ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"],
      requestBytes: true,
      responseBytes: true,
    },
  }),
});
```

方法列表和二进制能力在创建时复制。未声明的能力在发起请求前以 `UNSUPPORTED` 拒绝；其他目标按其验证结果配置，不直接复制 H5 的能力范围。适配器固定关闭自动 JSON 解析，将文本或 `ArrayBuffer` 交给核心；返回表示不符时以 `ADAPTER` 拒绝，不把对象重新序列化成原始文本。

原生 Cookie、超时等设置放在注入的请求函数中，保留适配器传入的回调、响应表示和正文。`timeoutMs` 管理 Reqvia 的调用预算，独立于原生请求器的超时。

## 使用 Service 类

接口定义同时包含路径构造、响应校验与领域返回值。`json()` 默认返回 `unknown`，业务类型由校验函数产生。

```ts
import { json } from "reqvia";
import type { CallOptions, HttpExecutor } from "reqvia";

interface User {
  id: string;
  name: string;
}

function parseUser(value: unknown): User {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    !("name" in value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string"
  ) {
    throw new TypeError("用户响应格式无效");
  }
  return { id: value.id, name: value.name };
}

class UserService {
  constructor(private readonly http: HttpExecutor) {}

  async find(id: string, options?: CallOptions): Promise<User> {
    const response = await this.http.request(
      { url: `users/${encodeURIComponent(id)}` },
      json(parseUser),
      options,
    );
    return response.data;
  }
}

const users = new UserService(http);
const user = await users.find("42");
```

Service 向下透传调用选项，向上返回业务需要的数据。若某个接口的调用者需要 HTTP 状态或响应头，该方法可以明确返回 `HttpResponse<User>`，不通过 `raw` 开关改变同一方法的返回形态。

同一接口也可以写为函数，执行依赖和返回约定不变：

```ts
async function findUser(executor: HttpExecutor, id: string, options?: CallOptions): Promise<User> {
  const { data } = await executor.request(
    { url: `users/${encodeURIComponent(id)}` },
    json(parseUser),
    options,
  );
  return data;
}
```

类适合归集一组相关接口，函数适合独立操作。二者都不需要继承库提供的业务基类。

## 发送正文与接收空响应

```ts
import { empty, jsonBody } from "reqvia";

await http.request(
  {
    url: "users/42",
    method: "PATCH",
    body: jsonBody({ name: "林舟" }),
  },
  empty(),
);
```

这里的接口约定是成功后没有响应正文。`empty()` 只接受空字符串；如果后端返回 JSON 对象，应改用对应 JSON 解码器。正文工具在调用处同步编码，编码异常应由包含整个调用表达式的错误处理边界捕获。

## 取消与错误处理

```ts
import { createCancellation, isHttpError } from "reqvia";

const source = createCancellation();
const pending = users.find("42", {
  cancellation: source.cancellation,
  timeoutMs: 5_000,
});

source.cancel("页面关闭");

try {
  await pending;
} catch (error: unknown) {
  if (!isHttpError(error) || error.kind !== "CANCELLED") {
    throw error;
  }
}
```

传给 Service 的是 `source.cancellation`，取消操作留在持有 source 的消费方。取消结束当前等待并尝试停止传输；它不撤销服务端已经处理的写入。

应用可以按 `kind` 处理自身需要的分支。HTTP 状态失败保留 `error.response`；解码器或业务校验函数抛出的异常仍可能是其他类型，因此 `catch` 参数按 `unknown` 处理。页面提示、跳转和日志放在应用的错误处理边界。

## 解析业务响应信封

HTTP 成功与业务成功分别判断。假设接口返回 `{ code, message, data }`，应用可以在 JSON 校验函数中解释该协议：

```ts
class BusinessError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "BusinessError";
  }
}

function parseUserEnvelope(value: unknown): User {
  if (
    typeof value !== "object" ||
    value === null ||
    !("code" in value) ||
    typeof value.code !== "number" ||
    !("message" in value) ||
    typeof value.message !== "string"
  ) {
    throw new TypeError("业务响应格式无效");
  }
  if (value.code !== 0) {
    throw new BusinessError(value.code, value.message);
  }
  if (!("data" in value)) {
    throw new TypeError("业务响应缺少 data");
  }
  return parseUser(value.data);
}

const { data: envelopeUser } = await http.request({ url: "users/42" }, json(parseUserEnvelope));
```

Reqvia 只负责 JSON 文本解析，不赋予 `code`、`message` 或 `data` 固定含义。这里的 `BusinessError` 和 `TypeError` 原样传播；HTTP 状态未被接受时则先产生 `STATUS`，不调用成功解码器。

## 接入外部取消信号

使用方已经持有 `AbortSignal` 时，通过兼容包建立绑定，并在调用结束后释放：

```ts
import { fromAbortSignal } from "@reqvia/compat-abort";

async function loadUser(id: string, signal: AbortSignal): Promise<User> {
  const binding = fromAbortSignal(signal);
  try {
    return await users.find(id, { cancellation: binding.cancellation });
  } finally {
    binding.dispose();
  }
}
```

正常完成也需要 `dispose()`，避免长期存活的 signal 积累监听。释放绑定只结束桥接，不主动取消调用。

反方向连接原生 API 时，显式提供控制器工厂：

```ts
import { toAbortSignal } from "@reqvia/compat-abort";

const nativeCancellation = createCancellation();
const nativeBinding = toAbortSignal(nativeCancellation.cancellation, () => new AbortController());
try {
  await fetch("https://api.example.com/health", { signal: nativeBinding.signal });
} finally {
  nativeBinding.dispose();
}
```

工厂每次返回独立且未取消的控制器，`nativeBinding.signal` 保留为原生 `AbortSignal` 类型。桥接只负责取消，不包装该原生调用的响应或错误。

## 会话与并发的职责

需要动态认证时，应用用实现 `HttpExecutor` 的包装器绑定一次会话及其代次（generation），在调用开始时捕获请求与凭证，在发送、恢复认证和交付结果前检查归属。退出登录或切换租户时使该代次失效；再次登录同一账号也形成新的代次。

旧会话的 401 只能作用于其所属会话，不能清理新会话。包装器只保证结果交付时归属仍有效；页面延迟更新、缓存写入和写后重新读取，应由相应状态拥有者在提交时检查自己的版本。

由一个上层模块统一执行重试。它固定请求输入，检查业务幂等性，并统一管理认证恢复、重试次数和总预算。每次尝试只获得剩余时间；剩余时间小于等于零时直接结束，不能传入 `timeoutMs: 0`，因为零表示关闭本库预算。

共享调用需要同时定义结果身份和消费者生命周期。影响结果的参数、请求头、认证分区与解码约定都应纳入共享规则；单个消费者取消只结束自己的等待，最后一个消费者退出后是否取消底层任务由共享请求模块决定。查询层已经负责共享、缓存和重试时，应用不再为同一调用叠加另一套管理逻辑。

一个 Service 方法顺序调用多个接口时，透传 `timeoutMs` 默认给每个 `request()` 各自的预算。需要整个业务操作共享期限时，由该操作建立总预算和取消边界，不能把多次五秒请求解释为整个方法最多五秒。
