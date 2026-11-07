<script setup lang="ts">
import { shallowRef } from "vue";

const query = shallowRef("");
const emit = defineEmits<{ search: [query: string]; cancel: []; leave: [] }>();
function select(value: string) {
  query.value = value;
  emit("search", value);
}
</script>

<template>
  <view class="search">
    <input
      v-model="query"
      class="query"
      data-testid="query"
      placeholder="搜索姓名"
      @confirm="emit('search', query)"
    />
    <button class="primary" data-testid="search" @tap="emit('search', query)">查询</button>
  </view>
  <view class="scenarios">
    <text class="hint">交互示例</text>
    <view class="actions">
      <button data-testid="normal" @tap="select('')">全部用户</button>
      <button data-testid="slow" @tap="select('slow')">慢速查询</button>
      <button data-testid="fast" @tap="select('fast')">快速查询</button>
      <button data-testid="invalid" @tap="select('invalid')">异常数据</button>
      <button data-testid="failure" @tap="select('error')">服务异常</button>
      <button data-testid="hang" @tap="select('hang')">等待响应</button>
      <button data-testid="cancel" @tap="emit('cancel')">取消查询</button>
      <button data-testid="leave" @tap="emit('leave')">离开列表</button>
    </view>
  </view>
</template>

<style scoped>
.search {
  display: flex;
  gap: 12px;
  margin: 24px 0 16px;
}
.query {
  flex: 1;
  min-width: 0;
  height: 44px;
  border: 1px solid #cdd4cf;
  padding: 0 12px;
  border-radius: 8px;
  background: #fff;
}
.primary {
  margin: 0;
  color: #fff;
  background: #205b4f;
}
.scenarios {
  margin-bottom: 24px;
}
.hint {
  color: #60746d;
  font-size: 12px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.actions button {
  margin: 0;
  padding: 0 12px;
  background: #e8ece7;
  line-height: 34px;
  font-size: 12px;
}
</style>
