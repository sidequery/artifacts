import type { CSSProperties, JSX, ReactNode } from "react";

import { useHostTheme } from "./hooks";
import { mergeStyle } from "./ui";

export type TextInputProps = {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  type?: "text" | "email" | "password" | "number" | "url" | "search";
  style?: CSSProperties;
};

export function TextInput({
  value,
  onChange,
  placeholder,
  disabled,
  type = "text",
  style,
}: TextInputProps): JSX.Element {
  const theme = useHostTheme();
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => onChange?.(event.target.value)}
      style={mergeStyle(fieldStyle(theme), style)}
    />
  );
}

export type TextAreaProps = {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
  style?: CSSProperties;
};

export function TextArea({
  value,
  onChange,
  placeholder,
  disabled,
  rows = 3,
  style,
}: TextAreaProps): JSX.Element {
  const theme = useHostTheme();
  return (
    <textarea
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      rows={rows}
      onChange={(event) => onChange?.(event.target.value)}
      style={mergeStyle({ ...fieldStyle(theme), height: "auto", padding: 8 }, style)}
    />
  );
}

export type CheckboxProps = {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  label?: ReactNode;
  style?: CSSProperties;
};

export function Checkbox({ checked, onChange, disabled, label, style }: CheckboxProps): JSX.Element {
  const theme = useHostTheme();
  return (
    <label style={mergeStyle({ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, color: theme.text.primary }, style)}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.checked)}
      />
      {label}
    </label>
  );
}

export type ToggleProps = {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  label?: ReactNode;
  style?: CSSProperties;
};

export function Toggle({ checked, onChange, disabled, label, style }: ToggleProps): JSX.Element {
  const theme = useHostTheme();
  return (
    <label style={mergeStyle({ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, color: theme.text.primary }, style)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange?.(!checked)}
        style={{
          width: 32,
          height: 18,
          borderRadius: 99,
          border: 0,
          background: checked ? theme.accent.control : theme.fill.primary,
          position: "relative",
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: checked ? 16 : 2,
            width: 14,
            height: 14,
            borderRadius: 99,
            background: theme.text.onAccent,
          }}
        />
      </button>
      {label}
    </label>
  );
}

export type SelectOption = { value: string; label: string };
export type SelectProps = {
  value?: string;
  onChange?: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  style?: CSSProperties;
};

export function Select({ value, onChange, options, disabled, style }: SelectProps): JSX.Element {
  const theme = useHostTheme();
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onChange?.(event.target.value)}
      style={mergeStyle(fieldStyle(theme), style)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function fieldStyle(theme: ReturnType<typeof useHostTheme>): CSSProperties {
  return {
    height: 28,
    padding: "0 8px",
    borderRadius: 6,
    border: `1px solid ${theme.stroke.secondary}`,
    background: theme.bg.elevated,
    color: theme.text.primary,
    fontSize: 13,
  };
}
