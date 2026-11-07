<script setup lang="ts">
import { shallowRef } from "vue";
import UserDirectory from "./components/UserDirectory.vue";

const open = shallowRef(true);
</script>

<template>
  <div class="shell">
    <header class="masthead">
      <a class="brand" href="/" aria-label="回到首页" data-testid="home-link"
        >reqvia<span class="brand-mark">●</span></a
      >
      <span class="edition">用户目录 · Web</span>
    </header>
    <main>
      <UserDirectory v-if="open" @leave="open = false" />
      <section v-else class="welcome" data-testid="welcome">
        <p class="eyebrow">目录已关闭</p>
        <h1>下次见。</h1>
        <p class="muted">重新打开目录，继续查找用户。</p>
        <button
          class="button primary"
          type="button"
          data-testid="open-directory"
          @click="open = true"
        >
          打开用户目录
        </button>
      </section>
    </main>
    <footer class="footer">通过姓名或角色找到需要联系的人。</footer>
  </div>
</template>

<style scoped>
.shell {
  max-width: 1080px;
  margin: 0 auto;
  padding: 32px 28px;
}
.masthead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 28px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 42px;
}
.brand {
  color: var(--ink);
  font-size: 25px;
  font-weight: 750;
  letter-spacing: -1.3px;
  text-decoration: none;
}
.brand-mark {
  color: var(--green);
  margin-left: 5px;
  font-size: 12px;
}
.edition {
  color: var(--muted);
  font-size: 13px;
}
.welcome {
  padding: 60px 0 100px;
}
.footer {
  margin-top: 56px;
  color: var(--muted);
  font-size: 13px;
}
@media (max-width: 600px) {
  .shell {
    padding: 22px 18px;
  }
  .masthead {
    margin-bottom: 30px;
  }
}
</style>
