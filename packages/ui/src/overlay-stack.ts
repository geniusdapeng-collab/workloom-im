/**
 * 所有临时浮层共享同一后进先出栈。
 * Esc 只允许最上层响应，避免 Popover、Dialog 与全屏表面被一次按键同时关闭。
 */
const overlayLayers: string[] = [];

export function activateOverlayLayer(id: string): () => void {
  const previousIndex = overlayLayers.lastIndexOf(id);
  if (previousIndex >= 0) overlayLayers.splice(previousIndex, 1);
  overlayLayers.push(id);
  return () => {
    const index = overlayLayers.lastIndexOf(id);
    if (index >= 0) overlayLayers.splice(index, 1);
  };
}

export function isTopOverlayLayer(id: string): boolean {
  return overlayLayers.at(-1) === id;
}
