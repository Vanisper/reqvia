<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount } from "vue";
import { users as service } from "../services.ts";
import { useUserDirectory } from "../composables/useUserDirectory.ts";
import SearchForm from "./SearchForm.vue";
import UserDetails from "./UserDetails.vue";
import UserList from "./UserList.vue";

defineEmits<{ leave: [] }>();
const {
  users,
  loading,
  error,
  notice,
  selectedId,
  selected,
  detailLoading,
  detailError,
  search,
  select,
  closeDetail,
  cancelSearch,
} = useUserDirectory(service);
const message = computed(() =>
  error.value instanceof Error ? error.value.message : error.value ? String(error.value) : "",
);
const detailMessage = computed(() =>
  detailError.value instanceof Error
    ? detailError.value.message
    : detailError.value
      ? String(detailError.value)
      : "",
);
function cancelPageRequests() {
  if (loading.value) cancelSearch();
  if (detailLoading.value) closeDetail();
}

onMounted(() => {
  window.addEventListener("pagehide", cancelPageRequests);
  void search("");
});
onBeforeUnmount(() => window.removeEventListener("pagehide", cancelPageRequests));
</script>

<template>
  <section data-testid="directory">
    <div class="page-heading">
      <div>
        <p class="eyebrow">PEOPLE</p>
        <h1>找到一起工作的人。</h1>
        <p class="muted">浏览团队成员，了解他们的角色。</p>
      </div>
      <button
        class="button quiet leave"
        type="button"
        data-testid="leave-directory"
        @click="$emit('leave')"
      >
        离开目录
      </button>
    </div>
    <SearchForm :loading="loading" @search="search" @cancel="cancelSearch" />
    <div class="feedback" aria-live="polite">
      <p v-if="loading" class="muted" role="status" data-testid="loading">正在查询…</p>
      <p v-else-if="message" class="error" role="alert" data-testid="list-error">{{ message }}</p>
      <p v-else-if="notice" class="muted" role="status" data-testid="notice">{{ notice }}</p>
    </div>
    <div class="directory-grid">
      <UserList :users="users" :loading="loading" :selected-id="selectedId" @select="select" />
      <UserDetails
        :selected-id="selectedId"
        :user="selected"
        :loading="detailLoading"
        :error="detailMessage"
        @close="closeDetail"
      />
    </div>
  </section>
</template>

<style scoped>
.page-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}
.leave {
  margin-top: 25px;
  white-space: nowrap;
}
.directory-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(250px, 1fr);
  gap: 24px;
  align-items: start;
}
.feedback {
  min-height: 26px;
  margin-bottom: 14px;
}
.feedback p {
  margin: 0;
}
@media (max-width: 700px) {
  .directory-grid {
    grid-template-columns: 1fr;
  }
  .page-heading {
    display: block;
  }
  .leave {
    margin-top: 10px;
  }
}
</style>
