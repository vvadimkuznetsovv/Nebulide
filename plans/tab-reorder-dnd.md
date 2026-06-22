# Feature: Горизонтальное перемещение вкладок через DnD

## Context
Вкладки (editor tabs в File Manager) можно перетаскивать только для открепления в отдельные панели. Нужно добавить горизонтальный reorder — перетаскивание вкладок для смены порядка внутри tab bar.

## Текущая ситуация

- **EditorTabButton** (`EditorPanel.tsx:379-504`) — `useDraggable({ id: 'editor-tab:${tab.id}' })`, attributes не spread'ится (overflow:auto parent clipping)
- **Workspace.tsx handleDragEnd** (строки 349-373) — обрабатывает только `edge-*`, `split-*`, `merge-*` drop targets
- **workspaceStore** — `openTabs: EditorTab[]`, нет метода reorder
- **DragOverlay** — уже рендерит ghost для `editor-tab:*` в Workspace.tsx

## Решение

### Шаг 1: workspaceStore — добавить `moveTab(fromIndex, toIndex)`

**Файл: `frontend/src/store/workspaceStore.ts`**

```ts
moveTab: (fromIndex: number, toIndex: number) => {
  set((state) => {
    if (fromIndex === toIndex) return state;
    const tabs = [...state.openTabs];
    const [moved] = tabs.splice(fromIndex, 1);
    tabs.splice(toIndex, 0, moved);
    const activeId = state.openTabs[state.activeTabIndex ?? -1]?.id;
    const newActiveIndex = activeId ? tabs.findIndex(t => t.id === activeId) : null;
    return {
      openTabs: tabs,
      activeTabIndex: newActiveIndex !== undefined && newActiveIndex >= 0 ? newActiveIndex : state.activeTabIndex,
    };
  });
},
```

### Шаг 2: EditorPanel — добавить drop zones между вкладками

**Файл: `frontend/src/components/editor/EditorPanel.tsx`**

Компонент `TabDropZone` — узкая зона между вкладками, подсвечивается при наведении:

```tsx
function TabDropZone({ index }: { index: number }) {
  const { isOver, setNodeRef } = useDroppable({ id: `tab-reorder:${index}` });
  return (
    <div
      ref={setNodeRef}
      style={{
        width: isOver ? 3 : 1,
        alignSelf: 'stretch',
        background: isOver ? 'var(--accent)' : 'transparent',
        transition: 'width 0.15s, background 0.15s',
        flexShrink: 0,
      }}
    />
  );
}
```

Drop zones видны только во время drag editor-tab (по `isDraggingEditorTab` из layoutStore).

### Шаг 3: Workspace.tsx handleDragEnd — обработать `tab-reorder:*`

В секции `editor-tab:`, перед edge/split/merge:
```ts
if (targetId.startsWith('tab-reorder:')) {
  const toIndex = parseInt(targetId.slice('tab-reorder:'.length), 10);
  const fromIndex = openTabs.findIndex(t => t.id === tabId);
  if (fromIndex >= 0 && toIndex !== fromIndex) {
    const adjustedTo = toIndex > fromIndex ? toIndex - 1 : toIndex;
    moveTab(fromIndex, adjustedTo);
  }
  return;
}
```

### Шаг 4: Collision detection — приоритет tab-reorder

При drag editor-tab, если среди коллизий есть `tab-reorder:*`, вернуть его (приоритет над split/edge/merge).

## Файлы для изменения

1. `frontend/src/store/workspaceStore.ts` — `moveTab(fromIndex, toIndex)`
2. `frontend/src/components/editor/EditorPanel.tsx` — `TabDropZone` + рендер между вкладками
3. `frontend/src/pages/Workspace.tsx` — `handleDragEnd` обработка `tab-reorder:*`, collision priority

## Verify
1. Перетащить вкладку влево/вправо — порядок меняется
2. Индикатор (фиолетовая линия) появляется между вкладками при drag
3. Перетаскивание на split/edge/merge — всё ещё работает (detach)
4. Active tab и temp tab сохраняют правильный индекс после reorder
5. `npx tsc --noEmit`
