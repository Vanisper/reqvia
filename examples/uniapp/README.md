# UniApp 消费示例

这是标准的 Vue 3 + TypeScript UniApp CLI 工程，包含 `App.vue`、`main.ts`、`pages.json` 和 `manifest.json`。用户目录与详情页调用共享的 `@reqvia/example-domain`；应用组装处把 `uni.request` 交给 `@reqvia/transport-uni`，业务 Service 无需了解页面或平台。

## 运行

在仓库根目录执行：

```sh
vp run -F @reqvia/example-uniapp dev
vp run -F @reqvia/example-uniapp build
vp run -F @reqvia/example-uniapp verify
```

开发服务默认位于 `http://127.0.0.1:4179`，内置与其他示例相同的本地 API。`build` 完成类型检查，生成 `dist/build/h5` 和 `dist/build/mp-weixin`。`verify` 分别启动生产静态服务和 Uni 开发服务，再用真实 Chrome 验证列表、详情、快速切换查询、业务校验错误、HTTP 错误、手动取消和页面卸载取消；服务端请求记录用于确认取消确实释放连接。

H5 默认使用同源 `/api/`。需要连接其他服务时，在本目录的 `.env.local` 中设置 `VITE_API_BASE_URL`，地址应以 `/` 结尾。

## 微信开发者工具

```sh
# 一个终端运行示例 API，默认端口 4178
vp run -F @reqvia/example-server start

# 另一个终端持续编译小程序
vp run -F @reqvia/example-uniapp dev:weixin
```

需要临时使用自己的 AppID 查看生产产物，也可以执行：

```sh
WEIXIN_APPID=你的AppID vp run -F @reqvia/example-uniapp open:weixin
```

该命令仅修改被忽略的编译产物配置。macOS 默认使用标准安装位置，其他安装位置通过 `WEIXIN_DEVTOOLS_CLI` 指定 CLI 路径。

在微信开发者工具中导入 `dist/dev/mp-weixin`，选择自己可使用的 AppID；需要手动设置时，只编辑此被忽略目录内的 `project.config.json`，不修改源 `manifest.json`。示例在小程序侧默认请求 `http://127.0.0.1:4178/api/`，已关闭开发工具的域名校验；真机需要改为设备可访问的 API 地址并按微信要求配置域名。

已完成 H5 开发与生产浏览器验证，以及微信开发者工具模拟器中的完整消费验收。微信环境为开发者工具 2.02.2611022、基础库 3.17.5，8 项覆盖列表、详情、同一详情页隐藏取消与恢复重载、快速切换查询、业务校验错误、HTTP 错误、手动取消和卸载取消。真机尚未验证。

可重复执行微信验收：

```sh
WEIXIN_APPID=你的AppID vp run -F @reqvia/example-uniapp verify:weixin
```

需要已登录的微信开发者工具并开启 CLI 服务端口；脚本自行启动 4178 端口的示例 API，通过自动化协议操作真实模拟器页面。`WEIXIN_DEVTOOLS_CLI` 指定 CLI 路径，`WEIXIN_AUTOMATION_PORT` 调整自动化端口（默认 9421）。AppID 只写入被忽略的编译产物，验收不上传代码或启动真机调试。

小程序执行域中的自由标识符 `URL` 不可直接使用。应用入口仅在 `MP-WEIXIN` 引入 [core-js 的标准 URL 实现](https://core-js.io/docs/features/web-standards/url-and-urlsearchparams)，编译配置把 `URL` 指向 `globalThis.URL`，避免被小程序模块包装器遮蔽。`performance.now()` 使用宿主已有单调时钟；入口在发请求前检查能力，缺失时明确失败。此项宿主装配位于消费应用，Reqvia 核心契约保持一致。

## 工具链与状态归属

UniApp 编译器、框架和宿主补齐依赖由根 `pnpm-workspace.yaml` 的 `catalogs.uniapp` 管理；TypeScript、VP 与 Node 类型使用默认 catalog，内部包使用 `workspace:*`。整个仓库共用 workspace 和锁文件。官方 Uni 编译器当前要求 Vite 5.2.8，因此根配置仅对本包设置精确 override；`vite.config.ts` 负责 VP 任务编排，`uni.config.ts` 交给官方 Uni CLI 编译。[官方 CLI 模板](https://github.com/dcloudio/uni-preset-vue/tree/vite-ts)也固定该 Vite 版本。使用 VP 自带的 Vite 8 编译小程序时，官方插件的 `uni:mp-main-js` 会因插件上下文不兼容而失败。

`useUsers()` 持有页面数据、加载和错误状态。每次新查询先取消上一请求，并用递增代次阻止旧结果提交；页面隐藏、卸载和组件销毁会释放当前请求。详情页单独持有自己的取消源。共享 Service 只负责端点调用与用户数据校验。
