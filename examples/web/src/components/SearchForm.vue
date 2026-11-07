<script setup lang="ts">
import { shallowRef } from "vue";

defineProps<{ loading: boolean }>();
const emit = defineEmits<{ search: [query: string]; cancel: [] }>();
const query = shallowRef("");
</script>

<template>
  <form class="search-form" @submit.prevent="emit('search', query.trim())">
    <label class="search-label" for="user-search">查找用户</label>
    <div class="search-row">
      <input
        id="user-search"
        v-model="query"
        class="search-input"
        name="query"
        type="search"
        placeholder="输入姓名或角色"
        autocomplete="off"
        data-testid="search-input"
      />
      <button class="button primary" type="submit" data-testid="search-submit">搜索</button>
      <button
        v-if="loading"
        class="button quiet"
        type="button"
        data-testid="search-cancel"
        @click="emit('cancel')"
      >
        取消
      </button>
    </div>
  </form>
</template>

<style scoped>
.search-form {
  margin: 30px 0 24px;
}
.search-label {
  display: block;
  margin-bottom: 10px;
  font-size: 13px;
  font-weight: 600;
}
.search-row {
  display: flex;
  gap: 10px;
}
.search-input {
  min-width: 0;
  flex: 1;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px 15px;
  font: inherit;
  background: white;
}
</style>
