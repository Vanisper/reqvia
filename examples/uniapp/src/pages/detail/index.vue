<script setup lang="ts">
import { onScopeDispose, shallowRef } from "vue";
import { onHide, onLoad, onShow, onUnload } from "@dcloudio/uni-app";
import type { User } from "@reqvia/example-domain";
import { createCancellation } from "reqvia";
import type { CancellationSource } from "reqvia";
import { createUsers } from "../../services/users.ts";

const user = shallowRef<User>();
const error = shallowRef("");
let id = "42";
let source: CancellationSource | undefined;
let visible = false;
let disposed = false;
let generation = 0;

function hide() {
  visible = false;
  generation++;
  source?.cancel("离开详情页");
  source = undefined;
}
function dispose() {
  disposed = true;
  hide();
}
async function load() {
  const version = ++generation;
  const current = createCancellation();
  source = current;
  user.value = undefined;
  error.value = "";
  try {
    const result = await createUsers().find(id, {
      cancellation: current.cancellation,
    });
    if (visible && version === generation) user.value = result;
  } catch (cause) {
    if (visible && version === generation)
      error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (version === generation) source = undefined;
  }
}
onLoad((options) => {
  id = String(options?.id ?? "42");
});
onShow(() => {
  if (visible || disposed) return;
  visible = true;
  void load();
});
onHide(hide);
onUnload(dispose);
onScopeDispose(dispose);
function back() {
  void uni.reLaunch({ url: "/pages/users/index" });
}
</script>

<template>
  <view class="page" data-testid="detail-page">
    <text class="eyebrow">用户详情</text>
    <view v-if="user" class="card">
      <text class="name" data-testid="detail-name">{{ user.name }}</text>
      <text class="role">{{ user.role }}</text>
      <text class="id">用户编号 {{ user.id }}</text>
    </view>
    <text v-else-if="error" class="error">{{ error }}</text>
    <text v-else>正在加载…</text>
    <button class="back" data-testid="back" @tap="back">返回用户目录</button>
  </view>
</template>

<style scoped>
.page {
  max-width: 720px;
  padding: 32px 20px;
  margin: 0 auto;
}
.eyebrow {
  color: #45796a;
  font-size: 13px;
}
.card {
  margin: 20px 0;
  background: #fff;
  padding: 28px;
  border-radius: 12px;
}
.name {
  display: block;
  font-size: 30px;
  font-weight: 600;
}
.role,
.id {
  display: block;
  color: #60746d;
  margin-top: 12px;
}
.back {
  color: #fff;
  background: #205b4f;
  margin-top: 24px;
}
.error {
  display: block;
  color: #a33e32;
  margin: 24px 0;
}
</style>
