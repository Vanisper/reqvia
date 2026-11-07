<script setup lang="ts">
import type { User } from "@reqvia/example-domain";

defineProps<{ users: readonly User[] }>();
const emit = defineEmits<{ select: [id: string] }>();
</script>

<template>
  <view class="list" data-testid="users">
    <view v-for="user in users" :key="user.id" class="item">
      <view
        ><text class="name" data-testid="user-name">{{ user.name }}</text
        ><text class="role">{{ user.role }}</text></view
      >
      <button :data-testid="`detail-${user.id}`" class="detail" @tap="emit('select', user.id)">
        查看详情
      </button>
    </view>
    <text v-if="users.length === 0" class="empty">没有匹配的用户</text>
  </view>
</template>

<style scoped>
.list {
  background: #fff;
  border: 1px solid #dde3dd;
  border-radius: 12px;
  overflow: hidden;
}
.item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px;
  border-bottom: 1px solid #edf0eb;
}
.item:last-child {
  border-bottom: none;
}
.name {
  display: block;
  font-size: 18px;
  font-weight: 600;
}
.role {
  display: block;
  margin-top: 6px;
  color: #718078;
  font-size: 13px;
}
.detail {
  color: #205b4f;
  margin: 0;
  background: #eff4ee;
}
.empty {
  display: block;
  padding: 24px;
  color: #718078;
}
</style>
