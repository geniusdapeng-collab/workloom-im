import {
  type ButtonHTMLAttributes,
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
} from "react";
import { Icon } from "./icons.js";
import type { IconName } from "./navigation.js";
import type { ButtonVariant } from "./components.js";

function joinIds(...ids: Array<string | undefined>): string | undefined {
  const value = [...new Set(ids.filter((id): id is string => Boolean(id)))].join(" ");
  return value || undefined;
}

export interface FieldPresentationProps {
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  hideLabel?: boolean;
  optionalLabel?: string;
  requiredLabel?: string;
  wrapperClassName?: string;
}

interface FieldFrameProps extends FieldPresentationProps {
  controlId: string;
  descriptionId: string;
  errorId: string;
  required?: boolean;
  children: ReactNode;
}

function FieldFrame({
  label,
  description,
  error,
  hideLabel = false,
  optionalLabel = "选填",
  requiredLabel = "必填",
  wrapperClassName = "",
  controlId,
  descriptionId,
  errorId,
  required,
  children,
}: FieldFrameProps) {
  return (
    <div
      className={`wl-field ${error ? "wl-field--error" : ""} ${wrapperClassName}`.trim()}
      data-invalid={error ? "true" : undefined}
      data-required={required ? "true" : undefined}
    >
      <label className={hideLabel ? "wl-visually-hidden" : "wl-field__label"} htmlFor={controlId}>
        <span>{label}</span>
        {required
          ? requiredLabel && <span className="wl-field__required">（{requiredLabel}）</span>
          : optionalLabel && <span className="wl-field__optional">（{optionalLabel}）</span>}
      </label>
      {children}
      {description && <div className="wl-field__description" id={descriptionId}>{description}</div>}
      {error && <div className="wl-field__error" id={errorId} role="alert">{error}</div>}
    </div>
  );
}

function fieldIds(id: string | undefined, generatedId: string) {
  const controlId = id || `wl-field-${generatedId}`;
  return {
    controlId,
    descriptionId: `${controlId}-description`,
    errorId: `${controlId}-error`,
  };
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size">, FieldPresentationProps {}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({
  label,
  description,
  error,
  hideLabel,
  optionalLabel,
  requiredLabel,
  wrapperClassName,
  id,
  className = "",
  required,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  ...props
}, ref) {
  const generatedId = useId();
  const ids = fieldIds(id, generatedId);
  return (
    <FieldFrame {...ids} label={label} description={description} error={error} hideLabel={hideLabel} optionalLabel={optionalLabel} requiredLabel={requiredLabel} wrapperClassName={wrapperClassName} required={required}>
      <input
        {...props}
        ref={ref}
        id={ids.controlId}
        required={required}
        aria-invalid={ariaInvalid ?? Boolean(error)}
        aria-errormessage={error ? ids.errorId : undefined}
        aria-describedby={joinIds(ariaDescribedBy, description ? ids.descriptionId : undefined, error ? ids.errorId : undefined)}
        className={`wl-input ${className}`.trim()}
      />
    </FieldFrame>
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement>, FieldPresentationProps {}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({
  label,
  description,
  error,
  hideLabel,
  optionalLabel,
  requiredLabel,
  wrapperClassName,
  id,
  className = "",
  required,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  children,
  ...props
}, ref) {
  const generatedId = useId();
  const ids = fieldIds(id, generatedId);
  return (
    <FieldFrame {...ids} label={label} description={description} error={error} hideLabel={hideLabel} optionalLabel={optionalLabel} requiredLabel={requiredLabel} wrapperClassName={wrapperClassName} required={required}>
      <select
        {...props}
        ref={ref}
        id={ids.controlId}
        required={required}
        aria-invalid={ariaInvalid ?? Boolean(error)}
        aria-errormessage={error ? ids.errorId : undefined}
        aria-describedby={joinIds(ariaDescribedBy, description ? ids.descriptionId : undefined, error ? ids.errorId : undefined)}
        className={`wl-select ${className}`.trim()}
      >
        {children}
      </select>
    </FieldFrame>
  );
});

export interface ComboboxOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface ComboboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "list" | "size">, FieldPresentationProps {
  options: readonly ComboboxOption[];
  listLabel?: string;
}

/**
 * 基于原生输入与 datalist 的轻量组合框：保留键盘、输入法和浏览器缩放能力，
 * 不在基础包内复制一套高风险的自制选择器。
 */
export const Combobox = forwardRef<HTMLInputElement, ComboboxProps>(function Combobox({
  options,
  listLabel = "可选项",
  label,
  description,
  error,
  hideLabel,
  optionalLabel,
  requiredLabel,
  wrapperClassName,
  id,
  className = "",
  required,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  ...props
}, ref) {
  const generatedId = useId();
  const ids = fieldIds(id, generatedId);
  const listId = `${ids.controlId}-options`;
  return (
    <FieldFrame {...ids} label={label} description={description} error={error} hideLabel={hideLabel} optionalLabel={optionalLabel} requiredLabel={requiredLabel} wrapperClassName={wrapperClassName} required={required}>
      <input
        {...props}
        ref={ref}
        id={ids.controlId}
        list={listId}
        required={required}
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-invalid={ariaInvalid ?? Boolean(error)}
        aria-errormessage={error ? ids.errorId : undefined}
        aria-describedby={joinIds(ariaDescribedBy, description ? ids.descriptionId : undefined, error ? ids.errorId : undefined)}
        className={`wl-input wl-combobox ${className}`.trim()}
      />
      <datalist id={listId} aria-label={listLabel}>
        {options.map((option) => <option value={option.value} label={option.label} disabled={option.disabled} key={option.value} />)}
      </datalist>
    </FieldFrame>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement>, FieldPresentationProps {}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({
  label,
  description,
  error,
  hideLabel,
  optionalLabel,
  requiredLabel,
  wrapperClassName,
  id,
  className = "",
  required,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  ...props
}, ref) {
  const generatedId = useId();
  const ids = fieldIds(id, generatedId);
  return (
    <FieldFrame {...ids} label={label} description={description} error={error} hideLabel={hideLabel} optionalLabel={optionalLabel} requiredLabel={requiredLabel} wrapperClassName={wrapperClassName} required={required}>
      <textarea
        {...props}
        ref={ref}
        id={ids.controlId}
        required={required}
        aria-invalid={ariaInvalid ?? Boolean(error)}
        aria-errormessage={error ? ids.errorId : undefined}
        aria-describedby={joinIds(ariaDescribedBy, description ? ids.descriptionId : undefined, error ? ids.errorId : undefined)}
        className={`wl-textarea ${className}`.trim()}
      />
    </FieldFrame>
  );
});

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  wrapperClassName?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox({
  label,
  description,
  error,
  wrapperClassName = "",
  id,
  className = "",
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  ...props
}, ref) {
  const generatedId = useId();
  const ids = fieldIds(id, generatedId);
  return (
    <div className={`wl-choice-field ${error ? "wl-choice-field--error" : ""} ${wrapperClassName}`.trim()}>
      <label className="wl-checkbox" htmlFor={ids.controlId}>
        <input
          {...props}
          ref={ref}
          type="checkbox"
          id={ids.controlId}
          aria-invalid={ariaInvalid ?? Boolean(error)}
          aria-errormessage={error ? ids.errorId : undefined}
          aria-describedby={joinIds(ariaDescribedBy, description ? ids.descriptionId : undefined, error ? ids.errorId : undefined)}
          className={`wl-checkbox__input ${className}`.trim()}
        />
        <span className="wl-checkbox__mark" aria-hidden />
        <span className="wl-choice-field__copy"><strong>{label}</strong>{description && <span id={ids.descriptionId}>{description}</span>}</span>
      </label>
      {error && <div className="wl-field__error" id={ids.errorId} role="alert">{error}</div>}
    </div>
  );
});

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  wrapperClassName?: string;
}

/** 单个单选项；同组项目由调用方传入相同 name，并以 fieldset/legend 包裹。 */
export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio({
  label,
  description,
  error,
  wrapperClassName = "",
  id,
  className = "",
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  ...props
}, ref) {
  const generatedId = useId();
  const ids = fieldIds(id, generatedId);
  return (
    <div className={`wl-choice-field ${error ? "wl-choice-field--error" : ""} ${wrapperClassName}`.trim()}>
      <label className="wl-radio" htmlFor={ids.controlId}>
        <input
          {...props}
          ref={ref}
          type="radio"
          id={ids.controlId}
          aria-invalid={ariaInvalid ?? Boolean(error)}
          aria-errormessage={error ? ids.errorId : undefined}
          aria-describedby={joinIds(ariaDescribedBy, description ? ids.descriptionId : undefined, error ? ids.errorId : undefined)}
          className={`wl-radio__input ${className}`.trim()}
        />
        <span className="wl-radio__mark" aria-hidden />
        <span className="wl-choice-field__copy"><strong>{label}</strong>{description && <span id={ids.descriptionId}>{description}</span>}</span>
      </label>
      {error && <div className="wl-field__error" id={ids.errorId} role="alert">{error}</div>}
    </div>
  );
});

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  wrapperClassName?: string;
}

export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch({
  label,
  description,
  error,
  wrapperClassName = "",
  id,
  className = "",
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  ...props
}, ref) {
  const generatedId = useId();
  const ids = fieldIds(id, generatedId);
  return (
    <div className={`wl-choice-field ${error ? "wl-choice-field--error" : ""} ${wrapperClassName}`.trim()}>
      <label className="wl-switch" htmlFor={ids.controlId}>
        <input
          {...props}
          ref={ref}
          type="checkbox"
          role="switch"
          id={ids.controlId}
          aria-invalid={ariaInvalid ?? Boolean(error)}
          aria-errormessage={error ? ids.errorId : undefined}
          aria-describedby={joinIds(ariaDescribedBy, description ? ids.descriptionId : undefined, error ? ids.errorId : undefined)}
          className={`wl-switch__input ${className}`.trim()}
        />
        <span className="wl-switch__track" aria-hidden><span className="wl-switch__thumb" /></span>
        <span className="wl-choice-field__copy"><strong>{label}</strong>{description && <span id={ids.descriptionId}>{description}</span>}</span>
      </label>
      {error && <div className="wl-field__error" id={ids.errorId} role="alert">{error}</div>}
    </div>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label" | "title"> {
  icon: IconName;
  label: string;
  variant?: ButtonVariant;
  iconSize?: number;
  busy?: boolean;
  tooltip?: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({
  icon,
  label,
  variant = "quiet",
  iconSize = 20,
  busy = false,
  tooltip,
  className = "",
  disabled,
  ...props
}, ref) {
  return (
    <button
      {...props}
      ref={ref}
      type="button"
      disabled={disabled || busy}
      aria-label={label}
      aria-busy={busy || undefined}
      title={tooltip ?? label}
      className={`wl-button wl-button--${variant} wl-icon-button ${className}`.trim()}
    >
      {busy ? <span className="wl-spinner wl-spinner--small" aria-hidden /> : <Icon name={icon} size={iconSize} />}
      <span className="wl-visually-hidden">{busy ? `${label}，处理中` : label}</span>
    </button>
  );
});
