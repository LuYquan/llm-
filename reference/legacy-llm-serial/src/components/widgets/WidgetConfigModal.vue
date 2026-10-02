<script setup lang="ts">
import CanvasWidgetConfigModal from './CanvasWidgetConfigModal.vue';
import type { CanvasWidgetInstance } from '../../types/widget';

defineProps<{
  isOpen: boolean;
  widget: CanvasWidgetInstance | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'save', updated: CanvasWidgetInstance): void;
}>();
</script>

<template>
  <CanvasWidgetConfigModal
    :is-open="isOpen"
    :widget="widget"
    @close="emit('close')"
    @save="emit('save', $event)"
  />
</template>
