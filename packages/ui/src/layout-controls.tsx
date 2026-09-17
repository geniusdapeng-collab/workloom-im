import { Button, Overlay } from "./components";

export const TEXT_SCALE_STEPS = [100, 125, 150, 175, 200] as const;
export type TextScale = typeof TEXT_SCALE_STEPS[number];

export interface LayoutControlsProps {
  open: boolean;
  onClose: () => void;
  textScale: TextScale;
  onTextScale: (scale: TextScale) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onShowAll: () => void;
  onFocusMode: () => void;
  onReset: () => void;
}

/**
 * 基座统一的“视图与布局”控制面。业务仓只能接回调，不能复制一套尺寸、全屏或恢复逻辑。
 */
export function LayoutControls({
  open,
  onClose,
  textScale,
  onTextScale,
  fullscreen,
  onToggleFullscreen,
  onShowAll,
  onFocusMode,
  onReset,
}: LayoutControlsProps) {
  return (
    <Overlay
      open={open}
      title="视图与布局"
      description="调整只保存在当前设备；恢复默认不会删除业务数据。"
      onClose={onClose}
      footer={<Button onClick={onClose}>完成</Button>}
    >
      <div className="wl-layout-controls">
        <section>
          <h3>文字大小</h3>
          <div className="wl-layout-controls__choices" role="group" aria-label="文字大小">
            {TEXT_SCALE_STEPS.map((scale) => (
              <Button
                key={scale}
                variant={textScale === scale ? "primary" : "secondary"}
                aria-pressed={textScale === scale}
                onClick={() => onTextScale(scale)}
              >
                {scale}%
              </Button>
            ))}
          </div>
          <p>最高支持 200% 文字放大，页面将重新排版，不会整体缩小画布。</p>
        </section>
        <section>
          <h3>窗口</h3>
          <div className="wl-layout-controls__choices">
            <Button onClick={onToggleFullscreen}>{fullscreen ? "退出全屏" : "进入全屏"}</Button>
            <Button onClick={onShowAll}>显示全部面板</Button>
            <Button onClick={onFocusMode}>进入专注布局</Button>
          </div>
        </section>
        <section>
          <h3>恢复</h3>
          <p>导航、AI 助手、数字秘书、文字大小和被拖动的位置会一起恢复。</p>
          <Button variant="danger" onClick={onReset}>恢复默认布局</Button>
        </section>
        <p className="wl-layout-controls__shortcut">快捷键：F11 全屏；⌘/Ctrl+B 折叠导航；⌘/Ctrl+K 打开 AI 助手；⌘/Ctrl+Shift+0 恢复布局。</p>
      </div>
    </Overlay>
  );
}
