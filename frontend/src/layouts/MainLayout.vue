<template>
  <q-layout view="hHh Lpr fFf" class="app-layout">
    <q-page-container>
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<script setup>
// Minimal game shell — each page provides its own toolbars/HUDs.
</script>

<style scoped>
.app-layout {
  background: #121212;
}
</style>
