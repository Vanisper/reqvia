<script setup lang="ts">
import { onHide, onLoad, onUnload } from "@dcloudio/uni-app";
import UserSearchForm from "../../components/UserSearchForm.vue";
import UserList from "../../components/UserList.vue";
import { useUsers } from "../../composables/useUsers.ts";

const { users, status, error, errorKind, search, cancel } = useUsers();
onLoad(() => {
  void search();
});
onHide(cancel);
onUnload(cancel);
function openDetail(id: string) {
  void uni.navigateTo({ url: `/pages/detail/index?id=${encodeURIComponent(id)}` });
}
function leave() {
  void uni.redirectTo({ url: "/pages/detail/index?id=42" });
}
</script>

<template>
  <view class="page">
    <text class="eyebrow">REQVIA / UNIAPP</text>
    <text class="title">用户目录</text>
    <text class="intro">查询用户、查看详情，并体验页面中的加载、错误与取消。</text>
    <UserSearchForm data-testid="search-form" @search="search" @cancel="cancel" @leave="leave" />
    <view class="status" data-testid="status" :data-state="status">
      <text v-if="status === 'loading'">正在加载…</text>
      <text v-else-if="status === 'cancelled'">查询已取消</text>
      <text v-else-if="status === 'error'" data-testid="error" :data-kind="errorKind">{{
        error
      }}</text>
      <text v-else-if="status === 'ready'">找到 {{ users.length }} 位用户</text>
    </view>
    <UserList
      data-testid="user-list"
      v-if="users.length > 0 || status === 'ready'"
      :users="users"
      @select="openDetail"
    />
  </view>
</template>

<style scoped>
.page {
  max-width: 720px;
  padding: 32px 20px 60px;
  margin: 0 auto;
}
.eyebrow {
  display: block;
  color: #45796a;
  letter-spacing: 3px;
  font-size: 11px;
  font-weight: 700;
}
.title {
  display: block;
  font-size: 32px;
  font-weight: 700;
  margin: 12px 0;
}
.intro {
  color: #60746d;
  font-size: 14px;
  line-height: 1.7;
}
.status {
  min-height: 28px;
  font-size: 13px;
  color: #52675c;
  margin-bottom: 10px;
}
</style>
