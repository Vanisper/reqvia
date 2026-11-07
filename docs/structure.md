# 项目结构与构建

Reqvia 使用 Vite Plus CLI 创建的 monorepo。工作区保留 `apps/*`、`packages/*`、`tools/*`，并以 `examples/*` 组织消费示例。所有包共用 pnpm workspace、catalog 和锁文件，由 Vite Plus 组织检查、测试与构建。

## 工作区结构

```text
reqvia/
├─ apps/
│  ├─ transport-check/      Fetch 与官方 Uni H5 请求运行时验证
│  └─ website/              Vite 应用示例
├─ examples/
│  ├─ shared/               三端复用的领域模型与 UserService
│  ├─ node/                 命令行消费、进程信号与资源清理
│  ├─ web/                  Vue 用户目录与 Fetch 消费
│  └─ uniapp/               UniApp 页面与 uni.request 消费
├─ packages/
│  ├─ compat-abort/         原生取消信号双向桥接
│  ├─ reqvia/               请求执行核心与编解码
│  ├─ transport-fetch/      Fetch 适配器
│  ├─ transport-uni/        UniApp 回调适配器
│  └─ utils/                TypeScript 库示例
├─ tools/
│  ├─ example-server/       本地 API 与浏览器验收工具
│  └─ verify-packages.mjs   独立打包产物消费验证
├─ docs/                    产品设计、契约、使用与验收
├─ .vite-hooks/             Vite Plus 提交检查
├─ AGENTS.md                工具与协作约定
├─ package.json             工作区命令与工具链要求
├─ pnpm-workspace.yaml      工作区范围、catalog 与依赖覆盖
├─ pnpm-lock.yaml           依赖锁文件
├─ tsconfig.json            根 TypeScript 配置
├─ vite.config.ts           根检查、格式与任务配置
└─ README.md
```

`website` 与 `utils` 是 CLI 生成的工程示例，用于验证应用构建、库打包和测试链路。`transport-check` 消费产品包的公共入口，在浏览器中对比两种传输。`tools/verify-packages.mjs` 验证独立安装的产品包；需要工具包时继续使用已有的 `tools/*` workspace 范围。

产品包放在 `packages/`，消费示例放在 `examples/`，仓库工具放在 `tools/`。`apps/` 保留模板应用与传输验收应用。三个消费端从 `@reqvia/example-domain` 复用领域模型与 Service，从各产品包的公共入口组装请求能力；本地后端和浏览器控制工具由私有工具包提供。

## 产品包规划

| 目录                       | 包名                      | 职责                             |
| -------------------------- | ------------------------- | -------------------------------- |
| `packages/reqvia`          | `reqvia`                  | 请求执行、公共契约、取消、编解码 |
| `packages/transport-fetch` | `@reqvia/transport-fetch` | Fetch 传输适配                   |
| `packages/transport-uni`   | `@reqvia/transport-uni`   | UniApp 传输适配                  |
| `packages/compat-abort`    | `@reqvia/compat-abort`    | 原生取消信号桥接                 |
| `packages/testing`         | `@reqvia/testing`         | 内存传输、响应脚本与调用记录     |

主包、两个适配器和取消桥接包均通过 `vp create vite:library` 创建；测试工具包按实际复用需求建立。扩展包独立安装，主包不捆绑平台实现。新增平台适配器沿用相同规则，不需要扩展核心中的平台枚举。

根目录的私有包名为 `reqvia-workspace`，产品主包名为 `reqvia`。根包始终 `private: true`；产品包在发布准备完成前也保持 private。包名不代表已在注册表中占用。

主包内部按职责分目录，保持一份公共入口：

```text
packages/reqvia/
├─ src/
│  ├─ core/                 客户端、规范化、生命周期与契约
│  ├─ codec/                JSON、文本、字节与空响应
│  └─ index.ts              公开导出
├─ tests/                   公共契约与类型测试
├─ package.json
├─ tsconfig.json
└─ vite.config.ts
```

模块内的文件随实现规模拆分。超时、取消和终态属于同一调用生命周期，不因概念名称不同就强制拆成多个公开模块。内部工具留在拥有它的模块，`utils` 示例不会发展为所有包共同依赖的杂项库。

## 依赖方向

| 使用方                     | 可以依赖           | 不应依赖                         |
| -------------------------- | ------------------ | -------------------------------- |
| 主包中的 `core`            | 自有契约与内部实现 | codec、适配器、UI 与原生请求类型 |
| 主包中的 `codec`           | core 公共契约      | 平台适配器                       |
| 适配器、取消桥接、测试工具 | `reqvia` 公开入口  | 主包源码路径、其他平台适配器     |
| 应用与验证工程             | 所需包的公开入口   | 跨包内部文件                     |

内部包通过 `workspace:` 协议声明依赖，不使用 `../../另一包/src` 或跨包路径别名。扩展包对主包声明兼容的 peer dependency，并以 workspace dev dependency 完成本仓库开发；构建将主包外部化。主包运行时不引入第三方请求器。

主包的测试替身在包内满足 `Transport` 即可；公开 `@reqvia/testing` 用于应用与跨包验收，避免主包的构建依赖反向指向测试扩展。测试替身不构成新的生产执行入口。

## Vite Plus 配置职责

根 `vite.config.ts` 统一格式、lint、类型检查和 staged 检查。包级文件负责该包的 `pack`、测试与运行配置。根目录执行的检查使用根配置，按包差异使用根配置的 `overrides`。[Vite Plus monorepo 指南](https://viteplus.dev/guide/monorepo)

保留 CLI 生成的 catalog、Vite 依赖覆盖与提交 hook。工具版本以 `pnpm-workspace.yaml` 和锁文件为准；当前基线为 Vite Plus 1.2.0，包管理器由根 `devEngines.packageManager` 固定为 pnpm 12.18.0。工具链的 Node 要求与 Reqvia 未来的运行兼容范围分别维护。

使用 `vp env doctor` 检查实际工具来源。若本机启用了优先使用系统工具的 `system_first` 模式，可单次指定项目包管理器运行安装，无需修改全局配置：`vp env exec --package-manager pnpm@12.18.0 pnpm install --frozen-lockfile`。

库包的 `build` 使用 `vp pack`，Web 应用使用 `vp build`，工作区使用 `vp run -r build`。`vp pack` 负责库输出与声明生成；不额外增加独立 tsdown 配置或并行的任务调度器。[Vite Plus 库打包](https://viteplus.dev/guide/pack)

依赖按实际版本约束归入 catalog：

| catalog  | 内容                                                          | 规则                          |
| -------- | ------------------------------------------------------------- | ----------------------------- |
| 默认     | Vite Plus、TypeScript、Node 类型、Vite 别名与验收用 WebSocket | 工作区共用工具链              |
| `web`    | Vue、Vue Vite 插件、Vue 类型检查器                            | 独立 Web 应用使用的版本       |
| `uniapp` | 官方 Uni 编译器、运行时、类型与匹配的 Vue、Vite               | DCloud 相关包使用同一发布批次 |

包中以 `catalog:web`、`catalog:uniapp` 引用对应版本，新增领域确有独立依赖约束时再增加具名 catalog。通用 TypeScript 固定为 6.0.3，以满足 Vue 类型检查器对编译器 JavaScript API 的要求；库声明由 `vp pack` 的 `tsc` generator 生成。

`transport-check` 通过 Vite Plus 构建官方 `@dcloudio/uni-h5` 的请求入口，使用与其版本一致的 `uni-h5-vue` 运行时。`examples/uniapp` 是完整 UniApp 工程：`vite.config.ts` 定义 VP 任务，`uni.config.ts` 供官方 Uni CLI 编译 H5 与微信小程序。官方插件当前依赖 Vite 5.2.8，根配置通过 `@reqvia/example-uniapp>vite` 精确覆盖本包；其他应用继续使用 VP 自带的 Vite。该编译器依赖不进入产品包。

产品包通过包级 `vite.config.ts` 的 `run.tasks` 声明构建依赖；适配器与取消桥接在构建和测试之前先构建主包，浏览器验证先构建消费应用。任务使用以下结构：

```ts
import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: "vp pack",
        dependsOn: [{ task: "build", from: ["dependencies", "peerDependencies"] }],
        cache: { output: ["dist/**"] },
      },
    },
  },
});
```

同一任务只在 script 或配置中定义一次。Fetch 测试、浏览器验证和打包消费验证包含真实网络或文件安装，任务设置 `cache: false`。其他纯构建任务使用 Vite Plus 的产物缓存。[Vite Plus 任务配置](https://viteplus.dev/config/run)

## 日常命令

在工作区根目录执行：

```sh
vp install --frozen-lockfile
vp run ready
```

`ready` 依次执行递归构建、检查、递归测试和打包消费验证。跨包检查从实际生成的声明解析公共入口。各步骤也可以独立运行：

| 命令                        | 用途                                            |
| --------------------------- | ----------------------------------------------- |
| `vp check`                  | 格式、lint 与类型检查                           |
| `vp run -r test`            | 执行声明了测试任务的 workspace 包               |
| `vp run -r build`           | 构建工作区中的应用与库                          |
| `vp run dev`                | 启动 `website` 开发服务                         |
| `vp -C packages/utils pack` | 单独打包库示例                                  |
| `vp toolchain`              | 查看实际使用的工具版本                          |
| `vp run verify:packages`    | 独立安装 tarball，验证运行入口与类型声明        |
| `vp run verify:browser`     | 构建并验证浏览器 Fetch 与官方 Uni H5 请求运行时 |
| `vp run verify:examples`    | 验证 Node CLI、Web 页面与完整 UniApp H5 工程    |

`vp check` 只负责静态检查，不代替测试、打包和产物消费验证。[Vite Plus 检查说明](https://viteplus.dev/guide/check)

`verify:browser` 与 `verify:examples` 需要本机 Chrome 或 Chromium，可通过 `CHROME_BIN` 指定可执行文件；这两个任务单独运行，不属于无需浏览器的 `ready` 流程。验证使用临时浏览器配置和本地 HTTP 服务，结束时清理。Uni H5 验证依赖保持在验证应用内，不进入产品包的运行依赖。

GitHub Actions 以固定版本的 Vite Plus、Node 与项目包管理器执行冻结安装、`ready` 和两组浏览器验收。微信开发者工具验收单独在本地执行，不属于 CI 环境。示例启动方式见[消费示例](../examples/README.md)。

## 产物与版本

产品包以 ESM 与类型声明作为首个交付目标，入口通过 `exports` 声明。需要其他模块格式时，以具体消费环境验证为依据增加；不通过提前承诺多种格式扩大首版验证范围。

发布检查从打包产物安装测试，核对导出、声明和跨包版本范围，不能只运行源码路径测试。源码不包含 Node、DOM 或 UniApp 专属类型的主包，另以不启用这些环境类型的消费工程验证。

版本记录按包维护，契约变更同时更新受影响的适配器与测试。正式发布前再接入版本与发布自动化，初始化阶段只建立本地 Git 基线。

## Git 管理

提交按文档、核心、适配器或工程配置组织。保留默认 staged 检查；依赖目录、缓存和构建产物不纳入版本管理。远程仓库与包发布独立于本地提交处理。
