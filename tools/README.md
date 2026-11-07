# 工程验证工具

`verify-packages.mjs` 验证构建后的 npm 包能被独立工程消费。先完成工作区构建，再运行：

```sh
vp run verify:packages
```

也可以直接运行脚本：

```sh
node tools/verify-packages.mjs
```

脚本优先使用 Vite Plus 提供的 `VP_CLI_BIN` 进入全局 CLI，直接运行时回退到 PATH 中的 `vp`。这样既能从工作区任务启动，也能保留项目声明的包管理器版本，无需修改全局环境偏好。

脚本按根配置声明的 pnpm 版本将 `reqvia` 和 `@reqvia/transport-fetch` 打包，在临时目录离线安装本地 tarball，并完成以下检查：

- 包名解析来自安装后的产物，peer dependency 已改写为版本范围
- 主包声明只需 ES2023 类型，不依赖 DOM 或 Node 类型
- JSON 校验结果正确推导，取消源与只读取消状态在类型上区分
- Fetch 适配器可使用标准 DOM 类型消费
- 同一份经过编译的 `UserService` 可切换内存传输与本地 HTTP 传输

临时消费者、tarball 和本地服务器在验证结束时清理。脚本不请求外部业务服务，不安装新的验证依赖；失败时返回非零状态。包含真实网络与文件安装的验证任务不应使用任务缓存。
