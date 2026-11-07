# Reqvia

Reqvia 是可扩展的 HTTP 客户端库，以稳定的执行契约连接业务接口与传输实现。业务通过普通函数或 Service 组织接口，按需组合响应解析、调用控制与请求策略。

当前已实现单次请求执行核心、Fetch 与 UniApp 适配器，以及原生取消信号桥接，包含编解码、配置派生、取消和总超时。产品包在工作区内开发，尚未发布。

## 解决什么问题

调用一个业务接口，需要把输入转换为请求、解释响应，并处理状态失败、取消与超时。接口数量和组合方式增加后，这些规则需要统一维护，也需要为认证、重试和状态管理留出明确的组合位置。Reqvia 以请求执行为中心组织这些能力，让业务协议、调用控制和传输实现各自有稳定的接口。

- 组织业务接口：函数和 Service 表达输入输出与领域方法
- 统一请求执行：成功、失败、取消和超时遵循明确规则
- 组合所需能力：编解码、执行器包装与传输适配分别扩展
- 验证调用行为：测试替身与真实传输遵循同一份契约

稳定的接口也让业务代码能够在不同运行环境中复用，新增传输实现时保持相同的调用方式。

## 基本用法

```ts
import { createFetchTransport } from "@reqvia/transport-fetch";
import { createHttpClient, json } from "reqvia";

const http = createHttpClient({
  baseURL: "https://api.example.com/v1/",
  transport: createFetchTransport({
    fetch,
    createAbortController: () => new AbortController(),
  }),
});

const { data, status } = await http.request({ url: "users/42", method: "GET" }, json());
```

`json()` 的结果类型为 `unknown`。传入校验或转换函数后，结果类型由该函数推导。调用返回普通 Promise，响应包含数据与 HTTP 元信息；业务 Service 可以只向上返回领域数据。

取消通过独立的控制对象传递：

```ts
import { createCancellation, json } from "reqvia";

const source = createCancellation();
const pending = http.request({ url: "users/42" }, json(), { cancellation: source.cancellation });

source.cancel("页面关闭");
await pending; // 以取消错误拒绝
```

完整的 Service、业务响应解析和取消桥接示例见[使用方式](docs/usage.md)。

## 能力与包规划

执行核心负责单次 HTTP 调用、编解码、取消与超时。应用和扩展模块围绕 `HttpExecutor` 组织认证、重试与并发协调；查询缓存、页面状态与 UI 通知由拥有相应状态的上层模块管理。

项目采用 monorepo，以 Vite Plus 组织开发、检查、测试与构建。`apps/website` 与 `packages/utils` 保留为 CLI 生成的工程示例，产品包按职责独立维护：

| 包                        | 职责                           | 状态   |
| ------------------------- | ------------------------------ | ------ |
| `reqvia`                  | 客户端、执行契约、取消与编解码 | 已实现 |
| `@reqvia/transport-fetch` | Fetch 传输适配                 | 已实现 |
| `@reqvia/transport-uni`   | UniApp 请求适配                | 已实现 |
| `@reqvia/compat-abort`    | 与 `AbortSignal` 的取消桥接    | 已实现 |
| `@reqvia/testing`         | 内存传输与可控响应             | 规划   |

Fetch 适配器已完成 Node 与浏览器本地 HTTP 验证，UniApp 适配器已通过官方 Uni H5 请求运行时验证。完整 UniApp 工程与小程序目标仍需分别验证。其他传输实现通过同一 `Transport` 接口接入，具体能力记录见[平台兼容性](docs/compatibility.md)。原生文件上传、下载落盘、进度与流属于独立扩展方向。

## 开发

在工作区根目录运行：

```sh
vp install --frozen-lockfile
vp run ready
```

`ready` 依次构建、检查、测试整个工作区，并验证独立安装的打包产物。先构建保证跨包检查使用实际导出的声明；`vp run dev` 启动 CLI 生成的应用示例。主包契约测试与 Fetch 的本地 HTTP 集成测试共同验证调用行为。

`vp run verify:browser` 另外运行 20 项浏览器双传输验证，需要本机 Chrome 或 Chromium；可用 `CHROME_BIN` 指定可执行文件。验证应用位于 `apps/transport-check`。

## 设计文档

| 文档                                 | 内容                                |
| ------------------------------------ | ----------------------------------- |
| [项目设计](docs/design.md)           | 定位、职责与核心取舍                |
| [公共契约](docs/contracts.md)        | 类型、执行顺序、默认规则与错误语义  |
| [使用方式](docs/usage.md)            | 客户端、Service、业务解码与取消桥接 |
| [项目结构](docs/structure.md)        | monorepo 目录、包依赖与工具约束     |
| [实施与验收](docs/implementation.md) | 实施顺序与各阶段完成条件            |
| [平台兼容性](docs/compatibility.md)  | 目标环境与验证记录                  |
