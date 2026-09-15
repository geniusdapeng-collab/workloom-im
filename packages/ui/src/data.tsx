import {
  type CSSProperties,
  type FormHTMLAttributes,
  type HTMLAttributes,
  type Key,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";
import { Badge, Button } from "./components";
import { Radio } from "./forms";
import { clientChineseText } from "./language";
import { Dialog } from "./overlays";

function clientNodeText(value: ReactNode, fallback: string): ReactNode {
  return typeof value === "string" ? clientChineseText(value, fallback) : value;
}

function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}

export interface ConfidenceProps extends HTMLAttributes<HTMLDivElement> {
  value: number;
  label?: string;
  description?: ReactNode;
}

/** 置信度始终同时给出数值和中文分级，颜色不是唯一编码。 */
export function Confidence({
  value,
  label = "置信度",
  description,
  className = "",
  ...props
}: ConfidenceProps) {
  const percent = Math.round(clampPercent(value));
  const level = percent >= 75 ? "较高" : percent >= 40 ? "一般" : "较低";
  const tone = percent >= 75 ? "success" : percent >= 40 ? "warning" : "danger";
  const descriptionId = useId();
  return (
    <div {...props} className={`wl-confidence ${className}`.trim()} aria-describedby={description ? descriptionId : undefined}>
      <span>{label}</span>
      <meter min={0} max={100} low={40} high={75} optimum={100} value={percent} aria-label={`${label}：${percent}%`} />
      <Badge tone={tone}>{level} · {percent}%</Badge>
      {description && <span className="wl-confidence__description" id={descriptionId}>{description}</span>}
    </div>
  );
}

export type DeltaDirection = "up" | "down" | "flat";

export interface DeltaProps extends HTMLAttributes<HTMLSpanElement> {
  value: number;
  label?: string;
  unit?: string;
  precision?: number;
  goodWhen?: "up" | "down" | "neutral";
}

export function deltaDirection(value: number): DeltaDirection {
  if (!Number.isFinite(value) || value === 0) return "flat";
  return value > 0 ? "up" : "down";
}

/** 趋势同时呈现箭头、文字和数值；goodWhen 由业务语义显式传入。 */
export function Delta({
  value,
  label = "变化",
  unit = "",
  precision = 1,
  goodWhen = "neutral",
  className = "",
  ...props
}: DeltaProps) {
  const direction = deltaDirection(value);
  const safePrecision = Math.min(6, Math.max(0, Math.floor(precision)));
  const amount = Number.isFinite(value) ? Math.abs(value).toFixed(safePrecision) : "0";
  const directionLabel = direction === "up" ? "上升" : direction === "down" ? "下降" : "持平";
  const favorable = goodWhen === "neutral" || direction === "flat" ? "neutral" : goodWhen === direction ? "positive" : "negative";
  return (
    <span {...props} className={`wl-delta wl-delta--${favorable} ${className}`.trim()} aria-label={`${label}：${directionLabel} ${amount}${unit}`}>
      <span aria-hidden>{direction === "up" ? "↑" : direction === "down" ? "↓" : "—"}</span>
      <span>{directionLabel}</span>
      <strong>{amount}{unit}</strong>
    </span>
  );
}

export type TableSortDirection = "ascending" | "descending" | "none";

export interface TableColumn<Row> {
  id: string;
  header: ReactNode;
  cell: (row: Row, index: number) => ReactNode;
  mobileLabel?: string;
  align?: "start" | "center" | "end";
  sortDirection?: TableSortDirection;
  onSort?: () => void;
  sortLabel?: string;
}

export interface TableProps<Row> extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  columns: readonly TableColumn<Row>[];
  rows: readonly Row[];
  getRowId?: (row: Row, index: number) => Key;
  caption?: ReactNode;
  captionHidden?: boolean;
  emptyLabel?: string;
  rowLabel?: (row: Row, index: number) => string;
}

/** 共享响应式数据表；窄屏用 data-label 重排，列标题仍保留原生 table 语义。 */
export function Table<Row>({
  columns,
  rows,
  getRowId,
  caption = "数据列表",
  captionHidden = false,
  emptyLabel = "暂无数据",
  rowLabel,
  className = "",
  ...props
}: TableProps<Row>) {
  return (
    <div {...props} className={`wl-table-wrap ${className}`.trim()} tabIndex={0} role="region" aria-label={typeof caption === "string" ? caption : "数据列表"}>
      <table className="wl-table">
        <caption className={captionHidden ? "wl-visually-hidden" : undefined}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th scope="col" aria-sort={column.sortDirection} className={`wl-table__cell--${column.align ?? "start"}`} key={column.id}>
                {column.onSort
                  ? <button type="button" className="wl-table__sort" onClick={column.onSort} aria-label={column.sortLabel ?? `按${typeof column.header === "string" ? column.header : "此列"}排序`}>{column.header}</button>
                  : column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0
            ? <tr><td className="wl-table__empty" colSpan={Math.max(1, columns.length)}>{emptyLabel}</td></tr>
            : rows.map((row, rowIndex) => (
              <tr key={getRowId?.(row, rowIndex) ?? rowIndex} aria-label={rowLabel?.(row, rowIndex)}>
                {columns.map((column) => (
                  <td
                    className={`wl-table__cell--${column.align ?? "start"}`}
                    data-label={column.mobileLabel ?? (typeof column.header === "string" ? column.header : "字段")}
                    key={column.id}
                  >
                    {column.cell(row, rowIndex)}
                  </td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

export interface FilterBarProps extends Omit<FormHTMLAttributes<HTMLFormElement>, "children"> {
  children: ReactNode;
  label?: string;
  resultCount?: number;
  onClear?: () => void;
  clearLabel?: string;
  actions?: ReactNode;
}

/** 搜索与筛选统一使用可换行表单；清除筛选不会依赖图标或英文缩写。 */
export function FilterBar({
  children,
  label = "筛选数据",
  resultCount,
  onClear,
  clearLabel = "清除筛选",
  actions,
  className = "",
  ...props
}: FilterBarProps) {
  return (
    <form {...props} className={`wl-filter-bar ${className}`.trim()} role="search" aria-label={label}>
      <div className="wl-filter-bar__fields">{children}</div>
      <div className="wl-filter-bar__actions">
        {typeof resultCount === "number" && <span role="status">共 {Math.max(0, Math.floor(resultCount))} 条结果</span>}
        {onClear && <Button type="button" variant="quiet" onClick={onClear}>{clearLabel}</Button>}
        {actions}
      </div>
    </form>
  );
}

export interface TimelineItem {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  time?: string;
  dateTime?: string;
  status?: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
}

export interface TimelineProps extends Omit<HTMLAttributes<HTMLOListElement>, "children"> {
  items: readonly TimelineItem[];
  label?: string;
  emptyLabel?: string;
}

/** 通用进展时间线；账本事件继续使用带回执语义的 LedgerTimeline。 */
export function Timeline({
  items,
  label = "进展时间线",
  emptyLabel = "暂无进展记录",
  className = "",
  ...props
}: TimelineProps) {
  return (
    <ol {...props} className={`wl-timeline ${className}`.trim()} aria-label={label}>
      {items.length === 0
        ? <li className="wl-timeline__empty">{emptyLabel}</li>
        : items.map((item) => (
          <li className={`wl-timeline__item wl-timeline__item--${item.tone ?? "neutral"}`} key={item.id}>
            <span className="wl-timeline__marker" aria-hidden />
            <div className="wl-timeline__content">
              <div className="wl-timeline__heading"><strong>{item.title}</strong>{clientNodeText(item.status, "状态待确认")}</div>
              {item.description && <div className="wl-timeline__description">{item.description}</div>}
              {item.time && <time dateTime={item.dateTime}>{item.time}</time>}
              {item.action && <div className="wl-timeline__action">{item.action}</div>}
            </div>
          </li>
        ))}
    </ol>
  );
}

export interface ChartDatum {
  id: string;
  label: string;
  value: number;
  displayValue?: string;
  tone?: "primary" | "success" | "warning" | "danger" | "info";
}

export interface ChartProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title: ReactNode;
  description?: ReactNode;
  data: readonly ChartDatum[];
  emptyLabel?: string;
}

function defaultChartValue(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(Number.isFinite(value) ? value : 0);
}

/** 无外部绘图库的基础条形图，并同步提供读屏数据表。 */
export function Chart({
  title,
  description,
  data,
  emptyLabel = "暂无可展示的数据",
  className = "",
  ...props
}: ChartProps) {
  const titleId = useId();
  const descriptionId = useId();
  const max = Math.max(0, ...data.map((item) => Math.abs(Number.isFinite(item.value) ? item.value : 0)));
  return (
    <figure {...props} className={`wl-chart ${className}`.trim()} aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}>
      <figcaption>
        <strong id={titleId}>{title}</strong>
        {description && <span id={descriptionId}>{description}</span>}
      </figcaption>
      {data.length === 0
        ? <div className="wl-chart__empty">{emptyLabel}</div>
        : (
          <>
            <div className="wl-chart__plot" aria-hidden>
              {data.map((item) => {
                const width = max === 0 ? 0 : Math.round((Math.abs(item.value) / max) * 100);
                const barStyle = { "--wl-chart-value": `${width}%` } as CSSProperties;
                return (
                  <div className="wl-chart__row" key={item.id}>
                    <span>{item.label}</span>
                    <span className="wl-chart__track"><span className={`wl-chart__bar wl-chart__bar--${item.tone ?? "primary"}`} style={barStyle} /></span>
                    <strong>{item.displayValue ?? defaultChartValue(item.value)}</strong>
                  </div>
                );
              })}
            </div>
            <table className="wl-visually-hidden">
              <caption>{title}</caption>
              <thead><tr><th scope="col">项目</th><th scope="col">数值</th></tr></thead>
              <tbody>{data.map((item) => <tr key={item.id}><th scope="row">{item.label}</th><td>{item.displayValue ?? defaultChartValue(item.value)}</td></tr>)}</tbody>
            </table>
          </>
        )}
    </figure>
  );
}

export interface ExportFormat {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

const DEFAULT_EXPORT_FORMATS: readonly ExportFormat[] = [
  { id: "csv", label: "CSV 表格", description: "适合数据分析和系统导入" },
  { id: "xlsx", label: "Excel 工作簿", description: "保留多列结构，适合人工查看" },
  { id: "pdf", label: "PDF 文档", description: "适合归档和分享" },
];

export interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  onExport: (formatId: string) => void;
  selectedFormat?: string;
  onFormatChange?: (formatId: string) => void;
  formats?: readonly ExportFormat[];
  title?: string;
  description?: string;
  exporting?: boolean;
  exportLabel?: string;
  cancelLabel?: string;
}

/** 导出确认统一显示格式含义；没有可用格式时禁止提交。 */
export function ExportDialog({
  open,
  onClose,
  onExport,
  selectedFormat,
  onFormatChange,
  formats = DEFAULT_EXPORT_FORMATS,
  title = "导出数据",
  description = "请选择导出格式。导出内容仍受当前账号的数据权限约束。",
  exporting = false,
  exportLabel = "开始导出",
  cancelLabel = "取消",
}: ExportDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const firstAvailable = formats.find((format) => !format.disabled)?.id;
  const [internalFormat, setInternalFormat] = useState(firstAvailable);
  const requestedFormat = selectedFormat ?? internalFormat;
  const effectiveFormat = requestedFormat && formats.some((format) => format.id === requestedFormat && !format.disabled)
    ? requestedFormat
    : firstAvailable;
  const safeClose = () => {
    if (!exporting) onClose();
  };
  return (
    <Dialog
      open={open}
      title={title}
      description={description}
      onClose={safeClose}
      initialFocusRef={cancelRef}
      closeDisabled={exporting}
      dismissOnBackdrop={!exporting}
      dismissOnEscape={!exporting}
      footer={(
        <>
          <Button ref={cancelRef} onClick={safeClose} disabled={exporting}>{cancelLabel}</Button>
          <Button variant="primary" busy={exporting} disabled={!effectiveFormat} onClick={() => effectiveFormat && onExport(effectiveFormat)}>{exportLabel}</Button>
        </>
      )}
    >
      <fieldset className="wl-export-dialog__formats">
        <legend>导出格式</legend>
        {formats.length === 0
          ? <p role="status">暂无可用的导出格式</p>
          : formats.map((format) => (
            <Radio
              name="export-format"
              value={format.id}
              label={format.label}
              description={format.description}
              checked={effectiveFormat === format.id}
              disabled={format.disabled || exporting}
              onChange={() => {
                if (selectedFormat === undefined) setInternalFormat(format.id);
                onFormatChange?.(format.id);
              }}
              key={format.id}
            />
          ))}
      </fieldset>
    </Dialog>
  );
}
