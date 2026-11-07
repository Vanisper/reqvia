# 公共契约

Reqvia 的执行入口是 `request(spec, decoder, options)`：请求描述决定发送什么，解码器决定怎样解释响应，调用选项决定取消、时间预算与成功状态。每次调用返回普通 Promise，至多调用一次 `Transport.send`。

本文定义首版 API 与行为；使用示例见[使用方式](usage.md)，各包职责见[项目结构](structure.md)。这些接口是实现与测试共同遵循的约定。

主包契约已实现。文末的取消兼容入口属于独立包规划，不在当前主包导出中。

## 客户端与执行器

```ts
interface HttpExecutor {
  request<T>(
    spec: RequestSpec,
    decoder: ResponseDecoder<T>,
    options?: CallOptions,
  ): Promise<HttpResponse<T>>;
}

interface HttpClient extends HttpExecutor {
  derive(defaults: ClientDefaults): HttpClient;
}

interface ClientDefaults {
  readonly baseURL?: string | undefined;
  readonly headers?: HeaderInput | undefined;
  readonly timeoutMs?: number | undefined;
  readonly acceptStatus?: ((status: number) => boolean) | undefined;
}

interface CallOptions {
  readonly cancellation?: Cancellation | undefined;
  readonly timeoutMs?: number | undefined;
  readonly acceptStatus?: ((status: number) => boolean) | undefined;
}

interface ResponseMeta {
  readonly status: number;
  readonly headers: HeaderFields;
  readonly url?: string;
}

interface HttpResponse<T> extends ResponseMeta {
  readonly data: T;
}

declare function createHttpClient(
  options: ClientDefaults & { readonly transport: Transport },
): HttpClient;
```

Service 依赖 `HttpExecutor`，不需要知道客户端配置、适配器或派生方式。`derive()` 复用同一 Transport，生成独立的默认配置快照；后续修改配置输入不会改变父实例或派生实例。更换 Transport 时创建新客户端。

`request()` 调用后即开始执行。同一 Promise 被多次等待不会重复发送；调用两次 `request()` 则形成两个独立调用。请求阶段的校验失败通过 Promise 拒绝；客户端创建和派生时的无效默认配置同步抛出 `CONFIG`。

`url` 只表示平台实际提供的最终响应 URL。平台未提供时省略，不能用原请求 URL 冒充。响应头也只包含平台可观察到的字段。

## 请求描述与正文

```ts
type HttpMethod = string;
type QueryValue = string | number | boolean | null | undefined;
type QueryInput = Readonly<Record<string, QueryValue | readonly QueryValue[]>>;
type HeaderInput = Readonly<Record<string, string | undefined>>;

type Payload =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "bytes"; readonly value: Uint8Array };

interface EncodedBody {
  readonly payload: Payload;
  readonly contentType?: string;
}

interface RequestSpec {
  readonly url: string;
  readonly method?: HttpMethod;
  readonly query?: QueryInput;
  readonly headers?: HeaderInput;
  readonly body?: EncodedBody;
}
```

`HttpMethod` 接受合法的 HTTP 方法 token。GET、HEAD、POST、PUT、PATCH、DELETE、OPTIONS、CONNECT、TRACE 统一为大写，其他扩展方法保留大小写；具体方法能否发送由适配器决定。

`body` 缺省表示没有请求正文；空字符串和零长度字节数组仍然是显式正文。GET、HEAD 携带任何显式正文都以 `CONFIG` 拒绝。

请求描述只保存值，不保存凭证读取函数、原生文件对象或平台任务。它便于快照，但不代表请求可以安全重试或共享：业务幂等性、平台隐含的凭证和其他影响结果的上下文仍需单独处理。

进入调用时同步复制请求配置、query 数组、头字段和字节正文。所有异步阶段使用这份快照。解码器的表示、函数引用及状态判断函数引用同时固定；函数闭包内部的可变状态不属于快照保证。

## 响应解码

```ts
type ResponseDecoder<T> =
  | {
      readonly representation: "text";
      readonly decode: (text: string, meta: ResponseMeta) => T | Promise<T>;
    }
  | {
      readonly representation: "bytes";
      readonly decode: (bytes: Uint8Array, meta: ResponseMeta) => T | Promise<T>;
    };

declare function json(): ResponseDecoder<unknown>;
declare function json<T>(parse: (value: unknown) => T | Promise<T>): ResponseDecoder<T>;
declare function text(): ResponseDecoder<string>;
declare function bytes(): ResponseDecoder<Uint8Array>;
declare function empty(): ResponseDecoder<null>;

declare function jsonBody(value: unknown): EncodedBody;
declare function textBody(value: string, contentType?: string): EncodedBody;
declare function bytesBody(value: Uint8Array, contentType?: string): EncodedBody;
```

| 工具               | 行为                                            |
| ------------------ | ----------------------------------------------- |
| `json()`           | 请求文本表示，执行 JSON 解析，返回 `unknown`    |
| `json(parse)`      | JSON 解析后调用 `parse`，结果类型由其返回值推导 |
| `text()`           | 返回文本，包括空字符串                          |
| `bytes()`          | 返回字节数组，包括零长度数组                    |
| `empty()`          | 请求文本表示，只接受空字符串，返回 `null`       |
| `jsonBody(value)`  | 使用 JSON 序列化，声明 `application/json`       |
| `textBody(value)`  | 保存文本，默认声明 `text/plain;charset=UTF-8`   |
| `bytesBody(value)` | 保存字节，默认声明 `application/octet-stream`   |

JSON 空正文和语法错误属于 `DECODE`。`empty()` 收到非空正文也属于 `DECODE`，空白字符不算空正文。`json(parse)` 中用户提供的 `parse` 异常，以及自定义解码器异常，均原样传播。

`jsonBody()` 在调用处同步完成编码。序列化抛错，或顶层值无法得到 JSON 文本时，抛出 `ENCODE`；这发生在 `request()` 之前，不计入该请求的超时。正文工具保留 JSON 序列化本身的值转换规则，不承担业务数据校验。

请求正文和响应表示互相独立。上传字节后可以接收 JSON，发送 JSON 后也可以接收字节；适配器不得据请求的 Content-Type 推断响应解码方式。

## 头字段

```ts
interface HeaderFields {
  get(name: string): string | undefined;
  getAll(name: string): readonly string[];
  entries(): Iterable<readonly [string, string]>;
}

declare function createHeaderFields(entries: Iterable<readonly [string, string]>): HeaderFields;
```

请求头使用单值记录。名称大小写无关，合并时规范为小写；同一层记录中出现仅大小写不同的重复名称属于 `CONFIG`。字段名必须有效，值不得含回车或换行。

客户端默认头、派生头和请求头逐层合并，后层覆盖前层。`undefined` 只在头字段中表示删除继承项；其他可选配置的 `undefined` 表示继承。

| 后层输入             | 对继承值的影响               |
| -------------------- | ---------------------------- |
| 未提供该字段         | 保留                         |
| 提供字符串           | 替换，空字符串也是有效覆盖值 |
| 显式提供 `undefined` | 删除                         |

正文的 `contentType` 只填补合并后缺失的 `content-type`。因此删除继承的 Content-Type 后，如果正文仍带有 `contentType`，该提示值会重新填入；显式字符串头始终优先。

响应头保留平台提供的重复条目和条目顺序，不自行拆分逗号。`get()` 返回第一个匹配值，`getAll()` 返回全部匹配值，没有匹配时分别返回 `undefined` 和空数组。`entries()` 返回小写名称。头字段对象不提供修改入口，返回的集合不能改变其内部状态。

`createHeaderFields()` 同步复制并校验输入，供适配器与测试工具构造中立响应。适配器提供的非法头字段属于 `ADAPTER`，不是请求配置错误。

## URL 与默认规则

URL 使用标准相对地址解析，不把 `baseURL` 当作字符串路径前缀。以 `https://api.example.com/v1/` 为基地址时，`users` 得到 `/v1/users`，`/users` 得到 `/users`，`../users` 得到 `/users`。

| 项目             | 规则                                                           |
| ---------------- | -------------------------------------------------------------- |
| `baseURL`        | 绝对 HTTP(S) URL，不含 query、fragment 或用户名密码            |
| 配置了 `baseURL` | 请求只接受相对地址；拒绝绝对地址和 `//host` 形式               |
| 未配置 `baseURL` | 请求必须提供绝对 HTTP(S) URL，不读取浏览器 location            |
| fragment         | 可在请求地址中出现，发送前移除，不属于服务器请求目标           |
| query            | 在 URL 现有参数之后追加，按字段和数组元素顺序保留重复键        |
| query 值         | 字符串、有限数字和布尔值转为文本；`null`、`undefined` 省略     |
| query 编码       | 输入原始值，由客户端编码；既有 URL 参数不重复编码              |
| 方法             | 省略时为 GET；接受合法方法 token，适配器检查具体方法的支持情况 |
| 默认状态判断     | 接受 200 至 299                                                |
| 默认超时         | 30 000 毫秒；`0` 关闭 Reqvia 的时间预算                        |
| 超时校验         | 负数、非有限数属于 `CONFIG`                                    |
| 单次选项         | `timeoutMs`、`acceptStatus` 覆盖客户端默认值                   |

`baseURL` 的末尾斜杠参与标准路径解析，例如 `https://api.example.com/v1` 与 `https://api.example.com/v1/` 的相对地址解析结果不同。客户端不自动补斜杠，也不限制相对路径中的 `..`。

所有地址均拒绝内嵌用户名和密码。配置了 `baseURL` 时，按 URL 解析语义识别绝对地址和网络路径引用，并确认解析后的 origin 与基地址一致；反斜线等可被解析器解释为主机切换的输入不能绕过此规则。非法地址以 `CONFIG` 拒绝。

平台对请求头、方法和二进制能力的限制由适配器处理。对已知无法实现的要求返回 `UNSUPPORTED`；不通过偷偷更换方法或把文本重新编码成字节来模拟支持。

## 调用生命周期

执行顺序固定为：入口快照与校验 → 请求规范化 → 单次传输 → 传输报文校验 → 状态判断 → 解码 → 提交结果。

状态未被接受时，以携带完整中立报文的 `STATUS` 拒绝，不执行成功解码器。`acceptStatus` 只改变状态接受条件；例如接受 404 后，该响应仍然经过原来选择的解码器。用户状态判断函数抛出的异常原样传播。

成功、失败、取消和超时只能提交一个终态。调用方收到终态后，后续取消、网络回调或异步解码结果都不能改变它。终态提交时释放本次调用的监听与计时器；迟到的 Promise 拒绝也必须被接收，不能产生未处理拒绝。

核心不发起重试，不刷新认证，不合并在途请求，不写入共享状态。传输成功也不表示某项写操作可以撤回；取消只能结束本次等待并尝试中止尚未完成的物理工作。

## 取消与时间预算

```ts
interface Cancellation {
  readonly cancelled: boolean;
  readonly reason?: unknown;
  subscribe(listener: () => void): () => void;
}

interface CancellationSource {
  readonly cancellation: Cancellation;
  cancel(reason?: unknown): void;
}

declare function createCancellation(): CancellationSource;
```

取消只发生一次，保留第一次的原因；重复 `cancel()` 幂等。已取消时，`subscribe()` 同步通知监听者。取消订阅函数幂等；单个监听者的异常不会传播到 `cancel()` 或阻止其他通知。同一个函数的多次订阅分别管理，退订其中一次不影响其他订阅。

总预算从进入 `request()` 起算，覆盖快照、规范化、传输、正文读取、状态判断和异步解码。调用前已取消时不启动传输。`timeoutMs: 0` 只关闭 Reqvia 的预算，平台和网络仍可能因各自的限制结束请求。

执行器同时使用主动通知和阶段检查：取消监听、超时计时器可以独立结束外层 Promise，不等待 Transport 或 decoder 完成；恢复异步执行和提交结果前再次检查期限，以处理同步工作阻塞计时器的情况。

所有终态竞争使用同一规则：

1. 已经提交终态时忽略后续候选结果。
2. 预算已耗尽时提交 `TIMEOUT`。
3. 否则，已收到调用方取消时提交 `CANCELLED`。
4. 否则，提交当前成功或失败结果。

计时采用不因系统时钟校准而倒退的经过时间。同步 JavaScript 工作无法被定时器强行打断；超时可以阻止迟到结果交付，不能承诺同步解码在期限到达的瞬间停止。解码器因此只承担转换与校验，不执行页面状态写入。

执行器为本次传输持有独立取消源。调用方取消或本库超时结束调用时，将取消通知传给适配器；适配器尝试中止底层工作。即使底层不响应取消，外层 Promise 也按上述规则结束。

## 传输契约

```ts
interface TransportRequest {
  readonly url: string;
  readonly method: HttpMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Payload;
  readonly representation: "text" | "bytes";
}

interface TransportControl {
  readonly cancellation: Cancellation;
}

interface HttpMessage extends ResponseMeta {
  readonly payload: Payload;
}

interface Transport {
  send(request: TransportRequest, control: TransportControl): Promise<HttpMessage>;
}
```

进入 `send()` 的请求已完成 URL 解析、query 编码、头字段合并与正文快照。适配器不再序列化业务对象，不读取全局业务会话，也不调用响应解码器。

响应正文的 `kind` 必须与请求的 `representation` 一致。没有正文的响应仍返回对应的空字符串或零长度字节数组，不使用第三种空表示。`text` 是平台解码后的文本，`bytes` 是平台提供的二进制正文；两者都不承诺包含 HTTP 报文框架或压缩传输字节。

收到可交付的最终 HTTP 响应时，适配器应 resolve，包括 4xx、5xx。响应状态须为 200 至 599 的整数。无法取得完整可交付正文时拒绝，不将已读的部分正文冒充完整响应。一次 `send()` 只发起一次底层请求调用；平台自动重定向不属于业务重试。

适配器只交付中立对象。响应及其字节正文交付后，不得继续修改；请求及其字节正文也不得被适配器修改。响应头通过 `createHeaderFields()` 复制为独立视图。

平台类型、原生任务和环境参数留在适配器包中。适配器构造时接收所需平台能力，核心既不导入它们，也不提供任意原生配置透传字段。

## 错误类型

```ts
type HttpErrorDetails = {
  readonly message?: string;
  readonly cause?: unknown;
} & (
  | { readonly kind: "CONFIG"; readonly field: string }
  | { readonly kind: "UNSUPPORTED"; readonly capability: string }
  | { readonly kind: "TRANSPORT" }
  | { readonly kind: "ADAPTER" }
  | { readonly kind: "STATUS"; readonly response: HttpMessage }
  | { readonly kind: "ENCODE" }
  | { readonly kind: "DECODE"; readonly response?: HttpMessage }
  | { readonly kind: "CANCELLED"; readonly reason?: unknown }
  | { readonly kind: "TIMEOUT"; readonly timeoutMs: number }
);

type HttpError = Error & HttpErrorDetails & { readonly name: "HttpError" };

declare function createHttpError(details: HttpErrorDetails): HttpError;
declare function isHttpError(value: unknown): value is HttpError;
```

| kind          | 含义                                               |
| ------------- | -------------------------------------------------- |
| `CONFIG`      | 客户端配置、请求输入或解码器形状无效               |
| `UNSUPPORTED` | 平台无法实现声明的能力                             |
| `TRANSPORT`   | 平台请求或正文读取失败，未取得完整响应             |
| `ADAPTER`     | 中立报文违反契约，例如表示不匹配、非法状态或头字段 |
| `STATUS`      | HTTP 状态未通过调用方的接受条件                    |
| `ENCODE`      | 内置正文工具无法完成编码                           |
| `DECODE`      | 内置响应工具无法完成解析或空正文校验               |
| `CANCELLED`   | 调用方取消本次调用                                 |
| `TIMEOUT`     | Reqvia 的本次调用预算耗尽                          |

Reqvia 自身产生的失败采用 `HttpError`。用户提供的解码器、JSON 校验函数和状态判断函数可能抛出其他异常，调用方应按 `unknown` 处理拒绝值；核心不猜测其中的业务状态码或异常含义。

适配器使用 `createHttpError()` 构造 `UNSUPPORTED`、`TRANSPORT` 或 `ADAPTER` 失败。未分类的 `send()` 抛错或拒绝由核心包装为 `TRANSPORT` 并保留 cause；适配器交付的错误报文，或自行产生其他类别的 `HttpError`，归为 `ADAPTER`。本库期限未到而平台自行超时时，也归 `TRANSPORT`，不能伪装成本库的 `TIMEOUT`。核心已经因取消或超时结束时，按终态规则忽略适配器的后续拒绝。

`STATUS.response` 保留适配器交付的完整中立响应，便于应用独立解析错误正文。诊断字段不会自动写入日志；`cause` 可以保留原始异常，但不构成稳定的平台 API。

## 取消兼容入口

```ts
// 来自 @reqvia/compat-abort
interface CancellationBinding {
  readonly cancellation: Cancellation;
  dispose(): void;
}

declare function fromAbortSignal(signal: AbortSignal): CancellationBinding;
```

`AbortSignal` 属于兼容包和相关适配器的原生接口，不进入主包公共契约。桥接保留已经发生的取消和原始 reason；之后的 abort 转为一次取消通知。`dispose()` 幂等，只移除桥接监听，不撤销已有取消，也不主动取消正在执行的请求。

桥接使用方在请求结束的 `finally` 中释放绑定，包括正常完成、失败、取消和超时路径。平台适配器内部建立的原生取消桥由适配器自行释放。
