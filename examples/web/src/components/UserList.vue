<script setup lang="ts">
import type { User } from "@reqvia/example-domain";

defineProps<{ users: readonly User[]; loading: boolean; selectedId: string | null }>();
const emit = defineEmits<{ select: [id: string] }>();
</script>

<template>
  <section class="user-list" :aria-busy="loading" aria-label="查询结果">
    <div class="list-heading">
      <h2 class="list-title">成员</h2>
      <span class="count" data-testid="user-count">{{ users.length }} 位</span>
    </div>
    <ul v-if="users.length" class="rows" data-testid="user-list">
      <li v-for="user in users" :key="user.id">
        <button
          class="user-row"
          :class="{ selected: selectedId === user.id }"
          :disabled="loading"
          :aria-pressed="selectedId === user.id"
          :data-testid="`user-${user.id}`"
          type="button"
          @click="emit('select', user.id)"
        >
          <span class="avatar" aria-hidden="true">{{ user.name.slice(0, 1) }}</span>
          <span class="user-name"
            >{{ user.name }}<span class="user-role">{{ user.role }}</span></span
          >
          <span class="chevron" aria-hidden="true">↗</span>
        </button>
      </li>
    </ul>
    <p v-else-if="!loading" class="empty" data-testid="empty-list">没有找到匹配的用户。</p>
  </section>
</template>

<style scoped>
.user-list {
  border: 1px solid var(--line);
  border-radius: 12px;
  background: white;
  overflow: hidden;
}
.list-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 18px 22px;
  border-bottom: 1px solid var(--line);
}
.list-title {
  font-size: 14px;
  margin: 0;
}
.count {
  color: var(--muted);
  font-size: 12px;
}
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}
.user-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 15px;
  border: 0;
  border-bottom: 1px solid var(--line);
  padding: 20px 22px;
  color: inherit;
  background: white;
  text-align: left;
  cursor: pointer;
  font: inherit;
}
.rows li:last-child .user-row {
  border-bottom: 0;
}
.user-row:hover,
.user-row.selected {
  background: var(--tint);
}
.user-row:disabled {
  cursor: wait;
  opacity: 0.6;
}
.avatar {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  color: var(--green);
  background: #edf3e8;
  font-size: 17px;
}
.user-name {
  font-weight: 650;
}
.user-role {
  display: block;
  margin-top: 5px;
  font-size: 12px;
  color: var(--muted);
  font-weight: 400;
}
.chevron {
  margin-left: auto;
  color: var(--muted);
}
.empty {
  padding: 30px 22px;
  color: var(--muted);
  font-size: 14px;
}
</style>
