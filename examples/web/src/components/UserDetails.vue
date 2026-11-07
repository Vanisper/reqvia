<script setup lang="ts">
import type { User } from "@reqvia/example-domain";

defineProps<{ selectedId: string | null; user: User | null; loading: boolean; error: string }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <aside class="details" aria-label="用户详情" :aria-busy="loading" data-testid="user-details">
    <div class="details-heading">
      <h2 class="details-title">用户详情</h2>
      <button
        v-if="selectedId"
        type="button"
        class="close"
        aria-label="关闭详情"
        data-testid="close-detail"
        @click="emit('close')"
      >
        ×
      </button>
    </div>
    <p v-if="loading" class="muted" role="status">正在读取详情…</p>
    <p v-else-if="error" class="error" role="alert" data-testid="detail-error">{{ error }}</p>
    <template v-else-if="user">
      <h3 class="detail-name" data-testid="detail-name">{{ user.name }}</h3>
      <dl class="fields">
        <dt class="field-label">角色</dt>
        <dd class="field-value">{{ user.role }}</dd>
        <dt class="field-label">用户编号</dt>
        <dd class="field-value">{{ user.id }}</dd>
      </dl>
    </template>
    <p v-else class="muted">选择一位成员，查看详细信息。</p>
  </aside>
</template>

<style scoped>
.details {
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--tint);
  padding: 20px 22px;
  min-height: 230px;
}
.details-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
}
.details-title {
  font-size: 14px;
  margin: 0;
}
.close {
  color: var(--muted);
  border: 0;
  background: transparent;
  cursor: pointer;
  font-size: 25px;
  line-height: 1;
}
.detail-name {
  font-size: 27px;
  margin: 0 0 24px;
  letter-spacing: -0.8px;
}
.fields {
  display: grid;
  grid-template-columns: 80px 1fr;
  gap: 16px;
  font-size: 13px;
}
.field-label {
  color: var(--muted);
}
.field-value {
  margin: 0;
}
</style>
