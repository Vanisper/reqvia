# Node 消费示例

命令行通过原生 Fetch、取消桥接和共享 `UserService` 消费 Reqvia 的公开入口。未传入 API 地址时，自动启动只监听本机的示例服务，并在调用结束后关闭。

```sh
vp run -F @reqvia/example-node start
vp run -F @reqvia/example-node start -- find 42
vp run -F @reqvia/example-node start -- list --query 林舟
```

结果以 JSON 写入标准输出，失败信息写入标准错误。领域校验错误、HTTP 状态失败和网络失败保留各自分类。可以明确连接正在运行的示例后端：

```sh
vp run -F @reqvia/example-node start -- list --base-url http://127.0.0.1:4178/api/
```

以下命令分别展示领域校验失败、超时和主动取消：

```sh
vp run -F @reqvia/example-node start -- list --query invalid
vp run -F @reqvia/example-node start -- list --query hang --timeout-ms 200
vp run -F @reqvia/example-node start -- list --query hang --timeout-ms 0
```

最后一条命令等待请求，按 Ctrl+C 结束。`SIGINT` 和 `SIGTERM` 经 `AbortController`、`fromAbortSignal()` 传到业务 Service，调用结束后释放桥接和进程监听；CLI 使用 `process.exitCode`，等待资源清理后自然退出。超时默认 5000 毫秒，0 关闭 Reqvia 的总预算。

| 退出码 | 含义                            |
| ------ | ------------------------------- |
| 0      | 成功或帮助                      |
| 1      | 领域校验、HTTP 或网络等调用失败 |
| 2      | 命令参数或客户端配置无效        |
| 124    | Reqvia 总超时                   |
| 130    | SIGINT 取消                     |
| 143    | SIGTERM 取消                    |

`vp run -F @reqvia/example-node test` 先构建依赖与 CLI，再从产物启动子进程，检查列表、详情、错误、超时和实际进程信号。慢响应测试同时观察服务端连接关闭；POSIX 信号用例在 Windows 跳过，未据此声明 Windows 控制台行为已验证。
