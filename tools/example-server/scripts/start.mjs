import { startExampleServer } from "@reqvia/example-server";

const server = await startExampleServer({ port: 4178 });
console.log(`示例 API：${server.baseURL}`);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void server.close());
