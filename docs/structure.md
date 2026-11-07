# 项目结构与构建

Reqvia 使用 Vite Plus CLI 创建的 monorepo。工作区沿用 `apps/*`、`packages/*`、`tools/*` 三类目录，由 pnpm 管理依赖，Vite Plus 组织检查、测试与构建。

## 工作区结构

```text
reqvia/
├─ apps/
│  └─ website/              Vite 应用示例
├─ packages/
│  └─ utils/                TypeScript 库示例
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

`website` 与 `utils` 是 CLI 生成的工程示例，用于验证应用构建、库打包和测试链路。它们不提供 Reqvia 的 HTTP 能力。`tools/*` 已纳入 workspace，出现实际工具包时再建立目录。

产品实现继续在这套结构中增加包。示例应用放在 `apps/`，可发布能力放在 `packages/`，仓库工具放在 `tools/`；不再建立平行的 `examples/` 或第二套构建工程。

## 产品包规划

| 目录                       | 包名                      | 职责                             |
| -------------------------- | ------------------------- | -------------------------------- |
| `packages/reqvia`          | `reqvia`                  | 请求执行、公共契约、取消、编解码 |
| `packages/transport-fetch` | `@reqvia/transport-fetch` | Fetch 传输适配                   |
| `packages/transport-uni`   | `@reqvia/transport-uni`   | UniApp 传输适配                  |
| `packages/compat-abort`    | `@reqvia/compat-abort`    | 原生取消信号桥接                 |
| `packages/testing`         | `@reqvia/testing`         | 内存传输、响应脚本与调用记录     |

这些是产品包的设计归属，按实现进度通过 `vp create vite:library` 创建；当前脚手架不等于这些包已经实现。扩展包独立安装，主包不捆绑平台实现。新增平台适配器沿用相同规则，不需要扩展核心中的平台枚举。

创建产品主包时，将根目录的私有包名改为 `reqvia-workspace`，为公开包 `reqvia` 保留名称。根包始终 `private: true`，应用与工具包也默认不发布。包名是工程规划，不代表已在注册表中占用。

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

库包的 `build` 使用 `vp pack`，应用使用 `vp build`，工作区使用 `vp run -r build`。`vp pack` 负责库输出与声明生成；不额外增加独立 tsdown 配置或并行的任务调度器。[Vite Plus 库打包](https://viteplus.dev/guide/pack)

UniApp 等需要专用编译器的验证应用保留平台编译链，将其构建命令注册为 workspace task，由 `vp run` 调度。统一任务入口不意味着替代每个运行环境的编译工具。

当前脚手架沿用 `package.json.scripts`。包之间出现构建依赖时，可将相应任务迁入包级 `vite.config.ts` 的 `run.tasks`，明确声明前置任务：

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

迁入配置后移除同名 script；同一任务只定义一次。真实网络、设备验证与发布任务不使用缓存。以上是扩展任务的配置方式，不是当前脚手架额外引入的一层封装。[Vite Plus 任务配置](https://viteplus.dev/config/run)

## 日常命令

在工作区根目录执行：

```sh
vp install --frozen-lockfile
vp run ready
```

`ready` 沿用 CLI 默认流程，依次执行检查、递归测试和递归构建。各步骤也可以独立运行：

| 命令                        | 用途                              |
| --------------------------- | --------------------------------- |
| `vp check`                  | 格式、lint 与类型检查             |
| `vp run -r test`            | 执行声明了测试任务的 workspace 包 |
| `vp run -r build`           | 构建工作区中的应用与库            |
| `vp run dev`                | 启动 `website` 开发服务           |
| `vp -C packages/utils pack` | 单独打包库示例                    |
| `vp toolchain`              | 查看实际使用的工具版本            |

跨包类型检查开始消费 `dist` 声明时，先构建依赖包，再运行检查和测试，并将这个顺序纳入 `ready`。运行 `vp check` 不代表测试或打包已经通过。[Vite Plus 检查说明](https://viteplus.dev/guide/check)

## 产物与版本

产品包以 ESM 与类型声明作为首个交付目标，入口通过 `exports` 声明。需要其他模块格式时，以具体消费环境验证为依据增加；不通过提前承诺多种格式扩大首版验证范围。

发布检查从打包产物安装测试，核对导出、声明和跨包版本范围，不能只运行源码路径测试。源码不包含 Node、DOM 或 UniApp 专属类型的主包，另以不启用这些环境类型的消费工程验证。

版本记录按包维护，契约变更同时更新受影响的适配器与测试。正式发布前再接入版本与发布自动化，初始化阶段只建立本地 Git 基线。

## Git 管理

提交按文档、核心、适配器或工程配置组织。保留默认 staged 检查；依赖目录、缓存和构建产物不纳入版本管理。远程仓库与包发布独立于本地提交处理。
