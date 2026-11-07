// #ifdef MP-WEIXIN
import "core-js/actual/url";
// #endif
import { createSSRApp } from "vue";
import App from "./App.vue";

export function createApp() {
  return { app: createSSRApp(App) };
}
