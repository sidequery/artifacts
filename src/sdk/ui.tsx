import {
  createContext,
  useContext,
  useState,
  type CSSProperties,
  type JSX,
  type ReactNode,
} from "react";

import { Link as RouterLink, type LinkProps } from "react-router";
import { useHostTheme } from "./hooks";
import { artifactTypography, toneColor, type Tone } from "./tokens";

const NestedText = createContext(false);

export function mergeStyle(base: CSSProperties, override?: CSSProperties): CSSProperties {
  return override ? { ...base, ...override } : { ...base };
}

export type StackProps = { children?: ReactNode; gap?: number; style?: CSSProperties };
export function Stack({ children, gap = 12, style }: StackProps): JSX.Element {
  return (
    <div style={mergeStyle({ display: "flex", flexDirection: "column", gap }, style)}>
      {children}
    </div>
  );
}

export type RowProps = {
  children?: ReactNode;
  gap?: number;
  align?: "start" | "center" | "end" | "stretch";
  justify?: "start" | "center" | "end" | "space-between";
  wrap?: boolean;
  style?: CSSProperties;
};
export function Row({
  children,
  gap = 8,
  align = "center",
  justify = "start",
  wrap,
  style,
}: RowProps): JSX.Element {
  return (
    <div
      style={mergeStyle(
        {
          display: "flex",
          flexDirection: "row",
          gap,
          alignItems: align,
          justifyContent: justify,
          flexWrap: wrap ? "wrap" : "nowrap",
        },
        style,
      )}
    >
      {children}
    </div>
  );
}

export type GridProps = {
  children?: ReactNode;
  columns: number | string;
  gap?: number;
  align?: "start" | "center" | "end" | "stretch";
  style?: CSSProperties;
};
export function Grid({ children, columns, gap = 12, align = "stretch", style }: GridProps): JSX.Element {
  const template = typeof columns === "number" ? `repeat(${columns}, minmax(0, 1fr))` : columns;
  return (
    <div
      style={mergeStyle(
        { display: "grid", gridTemplateColumns: template, gap, alignItems: align },
        style,
      )}
    >
      {children}
    </div>
  );
}

export function Divider({ style }: { style?: CSSProperties }): JSX.Element {
  const theme = useHostTheme();
  return (
    <div
      style={mergeStyle(
        { height: 1, background: theme.stroke.tertiary, width: "100%" },
        style,
      )}
    />
  );
}

export function Spacer(): JSX.Element {
  return <div style={{ flex: 1, minWidth: 0 }} />;
}

export type TextProps = {
  children?: ReactNode;
  tone?: "primary" | "secondary" | "tertiary" | "quaternary";
  size?: "body" | "small";
  as?: "p" | "span";
  weight?: "normal" | "medium" | "semibold" | "bold";
  italic?: boolean;
  truncate?: boolean | "start" | "end";
  style?: CSSProperties;
};
export function Text({
  children,
  tone = "primary",
  size = "body",
  as,
  weight = "normal",
  italic,
  truncate,
  style,
}: TextProps): JSX.Element {
  const theme = useHostTheme();
  const nested = useContext(NestedText);
  const Tag = as ?? (nested ? "span" : "p");
  const weights = { normal: 400, medium: 500, semibold: 590, bold: 700 };
  return (
    <NestedText.Provider value={true}>
      <Tag
        style={mergeStyle(
          {
            margin: Tag === "p" ? 0 : undefined,
            color: theme.text[tone],
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
            ...(size === "small" ? artifactTypography.small : artifactTypography.body),
            fontWeight: weights[weight],
            fontStyle: italic ? "italic" : undefined,
            overflow: truncate ? "hidden" : undefined,
            textOverflow: truncate ? "ellipsis" : undefined,
            whiteSpace: truncate ? "nowrap" : undefined,
            direction: truncate === "start" ? "rtl" : undefined,
          },
          style,
        )}
      >
        {children}
      </Tag>
    </NestedText.Provider>
  );
}

export function H1({ children, style }: { children?: ReactNode; style?: CSSProperties }): JSX.Element {
  const theme = useHostTheme();
  return (
    <h1
      style={mergeStyle(
        {
          margin: 0,
          color: theme.text.primary,
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          ...artifactTypography.h1,
        },
        style,
      )}
    >
      {children}
    </h1>
  );
}

export function H2({ children, style }: { children?: ReactNode; style?: CSSProperties }): JSX.Element {
  const theme = useHostTheme();
  return (
    <h2
      style={mergeStyle(
        {
          margin: 0,
          color: theme.text.primary,
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          ...artifactTypography.h2,
        },
        style,
      )}
    >
      {children}
    </h2>
  );
}

export function H3({ children, style }: { children?: ReactNode; style?: CSSProperties }): JSX.Element {
  const theme = useHostTheme();
  return (
    <h3
      style={mergeStyle(
        {
          margin: 0,
          color: theme.text.primary,
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          ...artifactTypography.h3,
        },
        style,
      )}
    >
      {children}
    </h3>
  );
}

export function Code({ children, style }: { children?: ReactNode; style?: CSSProperties }): JSX.Element {
  const theme = useHostTheme();
  return (
    <code
      style={mergeStyle(
        {
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: "0.92em",
          background: theme.fill.tertiary,
          padding: "1px 4px",
          borderRadius: 4,
          color: theme.text.primary,
        },
        style,
      )}
    >
      {children}
    </code>
  );
}

export function Link(props: LinkProps | { children?: ReactNode; href: string; style?: CSSProperties }): JSX.Element {
  const theme = useHostTheme();
  const style = mergeStyle({ color: theme.text.link, textDecoration: "underline" }, props.style);
  if ("to" in props) return <RouterLink {...props} style={style} />;
  return <a href={props.href} style={style}>{props.children}</a>;
}

export type CardProps = {
  children?: ReactNode;
  variant?: "default" | "borderless";
  size?: "base" | "lg";
  collapsible?: boolean;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  style?: CSSProperties;
};
export function Card({
  children,
  variant = "default",
  collapsible,
  defaultOpen = true,
  open,
  onOpenChange,
  style,
}: CardProps): JSX.Element {
  const theme = useHostTheme();
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  const isOpen = open ?? uncontrolled;
  const setOpen = (next: boolean) => {
    if (open === undefined) {
      setUncontrolled(next);
    }
    onOpenChange?.(next);
  };
  return (
    <div
      style={mergeStyle(
        {
          background: theme.bg.elevated,
          border: variant === "borderless" ? "none" : `1px solid ${theme.stroke.tertiary}`,
          borderRadius: variant === "borderless" ? 0 : 8,
          overflow: "hidden",
        },
        style,
      )}
    >
      <CardContext.Provider value={{ collapsible: Boolean(collapsible), open: isOpen, setOpen }}>
        {children}
      </CardContext.Provider>
    </div>
  );
}

const CardContext = createContext({
  collapsible: false,
  open: true,
  setOpen: (_open: boolean) => {},
});

export function CardHeader({
  children,
  trailing,
  style,
}: {
  children?: ReactNode;
  trailing?: ReactNode;
  style?: CSSProperties;
}): JSX.Element {
  const theme = useHostTheme();
  const card = useContext(CardContext);
  const content = (
    <div
      style={mergeStyle(
        {
          display: "flex",
          alignItems: "center",
          gap: 8,
          minHeight: 28,
          padding: "8px 12px",
          borderBottom: card.open ? `1px solid ${theme.stroke.tertiary}` : "none",
          color: theme.text.secondary,
          fontSize: 12,
          fontWeight: 500,
        },
        style,
      )}
    >
      {card.collapsible ? <span style={{ width: 10 }}>{card.open ? "▾" : "▸"}</span> : null}
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      {trailing}
    </div>
  );
  if (!card.collapsible) {
    return content;
  }
  return (
    <button
      type="button"
      onClick={() => card.setOpen(!card.open)}
      style={{ display: "block", width: "100%", background: "none", border: 0, padding: 0, textAlign: "left", cursor: "pointer" }}
    >
      {content}
    </button>
  );
}

export function CardBody({ children, style }: { children?: ReactNode; style?: CSSProperties }): JSX.Element | null {
  const card = useContext(CardContext);
  if (!card.open) {
    return null;
  }
  return <div style={mergeStyle({ padding: 12 }, style)}>{children}</div>;
}

export type TableColumnAlign = "left" | "center" | "right";
export type TableRowTone = Tone;
export type TableProps = {
  headers: ReactNode[];
  rows: ReactNode[][];
  columnAlign?: Array<TableColumnAlign | undefined>;
  rowTone?: Array<TableRowTone | undefined>;
  framed?: boolean;
  striped?: boolean;
  stickyHeader?: boolean;
  emptyMessage?: ReactNode;
  style?: CSSProperties;
};
export function Table({
  headers,
  rows,
  columnAlign,
  rowTone,
  framed = true,
  striped,
  stickyHeader,
  emptyMessage,
  style,
}: TableProps): JSX.Element {
  const theme = useHostTheme();
  const body = rows.length === 0 ? (
    <tr>
      <td colSpan={headers.length} style={{ padding: 12, color: theme.text.tertiary }}>
        {emptyMessage}
      </td>
    </tr>
  ) : (
    rows.map((row, rowIndex) => (
      <tr
        key={rowIndex}
        style={{
          background: striped && rowIndex % 2 === 1 ? theme.fill.quaternary : undefined,
        }}
      >
        {headers.map((_, columnIndex) => (
          <td
            key={columnIndex}
            style={{
              padding: "8px 10px",
              textAlign: columnAlign?.[columnIndex] ?? "left",
              borderTop: `1px solid ${theme.stroke.tertiary}`,
              color: theme.text.primary,
              fontSize: 13,
            }}
          >
            {columnIndex === 0 && rowTone?.[rowIndex] ? (
              <span
                style={{
                  display: "inline-block",
                  width: 6,
                  height: 6,
                  borderRadius: 99,
                  background: toneColor(theme, rowTone[rowIndex]),
                  marginRight: 8,
                }}
              />
            ) : null}
            {row[columnIndex] ?? ""}
          </td>
        ))}
      </tr>
    ))
  );
  const table = (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          {headers.map((header, index) => (
            <th
              key={index}
              style={{
                textAlign: columnAlign?.[index] ?? "left",
                padding: "8px 10px",
                color: theme.text.secondary,
                fontSize: 12,
                fontWeight: 500,
                position: stickyHeader ? "sticky" : undefined,
                top: stickyHeader ? 0 : undefined,
                background: theme.bg.elevated,
              }}
            >
              {header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{body}</tbody>
    </table>
  );
  if (!framed) {
    return table;
  }
  return (
    <div
      style={mergeStyle(
        {
          border: `1px solid ${theme.stroke.tertiary}`,
          borderRadius: 8,
          overflow: "auto",
          background: theme.bg.elevated,
        },
        style,
      )}
    >
      {table}
    </div>
  );
}

export type ButtonProps = {
  children?: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  style?: CSSProperties;
  onClick?: () => void;
};
export function Button({
  children,
  variant = "secondary",
  disabled,
  type = "button",
  style,
  onClick,
}: ButtonProps): JSX.Element {
  const theme = useHostTheme();
  const variants: Record<string, CSSProperties> = {
    primary: {
      background: theme.accent.control,
      color: theme.text.onAccent,
      border: "1px solid transparent",
    },
    secondary: {
      background: theme.fill.secondary,
      color: theme.text.primary,
      border: `1px solid ${theme.stroke.secondary}`,
    },
    ghost: {
      background: "transparent",
      color: theme.text.secondary,
      border: "1px solid transparent",
    },
  };
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      style={mergeStyle(
        {
          height: 24,
          padding: "0 10px",
          borderRadius: 6,
          fontSize: 12,
          fontWeight: 500,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.5 : 1,
          width: "max-content",
          ...variants[variant],
        },
        style,
      )}
    >
      {children}
    </button>
  );
}

export type PillProps = {
  children?: ReactNode;
  active?: boolean;
  size?: "sm" | "md";
  disabled?: boolean;
  style?: CSSProperties;
  onClick?: () => void;
};
export function Pill({ children, active, size = "md", disabled, style, onClick }: PillProps): JSX.Element {
  const theme = useHostTheme();
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={mergeStyle(
        {
          height: size === "sm" ? 20 : 24,
          padding: size === "sm" ? "0 6px" : "0 10px",
          borderRadius: 999,
          border: active || size === "sm" ? "none" : `1px solid ${theme.stroke.secondary}`,
          background: active ? theme.fill.primary : "transparent",
          color: theme.text.primary,
          fontSize: size === "sm" ? 11 : 12,
          cursor: onClick && !disabled ? "pointer" : "default",
        },
        style,
      )}
    >
      {children}
    </button>
  );
}

export type StatProps = {
  value: ReactNode;
  label: string;
  tone?: "success" | "danger" | "warning" | "info";
  style?: CSSProperties;
};
export function Stat({ value, label, tone, style }: StatProps): JSX.Element {
  const theme = useHostTheme();
  return (
    <div style={style}>
      <div style={{ fontSize: 24, lineHeight: "30px", fontWeight: 590, color: toneColor(theme, tone) }}>
        {value}
      </div>
      <div style={{ fontSize: 12, lineHeight: "16px", color: theme.text.secondary }}>{label}</div>
    </div>
  );
}

export type CalloutProps = {
  children?: ReactNode;
  tone?: Tone;
  title?: ReactNode;
  style?: CSSProperties;
};
export function Callout({ children, tone = "info", title, style }: CalloutProps): JSX.Element {
  const theme = useHostTheme();
  const color = toneColor(theme, tone);
  return (
    <div
      style={mergeStyle(
        {
          border: `1px solid ${theme.stroke.tertiary}`,
          borderLeft: `3px solid ${color}`,
          borderRadius: 6,
          padding: 12,
          background: theme.bg.elevated,
        },
        style,
      )}
    >
      {title ? (
        <div style={{ fontWeight: 590, color: theme.text.primary, marginBottom: 4, fontSize: 13 }}>
          {title}
        </div>
      ) : null}
      <div style={{ color: theme.text.secondary, fontSize: 13 }}>{children}</div>
    </div>
  );
}
