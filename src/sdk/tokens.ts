export type Tone = "success" | "danger" | "warning" | "info" | "neutral";

export type CanvasPalette = {
  foreground: string;
  foregroundSecondary: string;
  foregroundTertiary: string;
  foregroundQuaternary: string;
  editor: string;
  chrome: string;
  sidebar: string;
  elevated: string;
  fillPrimary: string;
  fillSecondary: string;
  fillTertiary: string;
  fillQuaternary: string;
  strokePrimary: string;
  strokeSecondary: string;
  strokeTertiary: string;
  strokeFocused: string;
  accent: string;
  buttonBackground: string;
  buttonForeground: string;
  buttonHoverBackground: string;
  link: string;
  success: string;
  danger: string;
  warning: string;
  info: string;
};

export const canvasPaletteDark: CanvasPalette = {
  foreground: "#F0F0F0",
  foregroundSecondary: "#C2C2C2",
  foregroundTertiary: "#9A9A9A",
  foregroundQuaternary: "#6E6E6E",
  editor: "#181818",
  chrome: "#141414",
  sidebar: "#121212",
  elevated: "#1E1E1E",
  fillPrimary: "#2A2A2A",
  fillSecondary: "#242424",
  fillTertiary: "#202020",
  fillQuaternary: "#1C1C1C",
  strokePrimary: "#3A3A3A",
  strokeSecondary: "#2E2E2E",
  strokeTertiary: "#262626",
  strokeFocused: "#81A1C1",
  accent: "#81A1C1",
  buttonBackground: "#81A1C1",
  buttonForeground: "#141414",
  buttonHoverBackground: "#97B4D0",
  link: "#88C0D0",
  success: "#A3BE8C",
  danger: "#BF616A",
  warning: "#EBCB8B",
  info: "#88C0D0",
};

export const canvasPaletteLight: CanvasPalette = {
  foreground: "#141414",
  foregroundSecondary: "#3A3A3A",
  foregroundTertiary: "#5C5C5C",
  foregroundQuaternary: "#8A8A8A",
  editor: "#F7F7F5",
  chrome: "#EFEFEA",
  sidebar: "#E8E8E2",
  elevated: "#FFFFFF",
  fillPrimary: "#E6E6E0",
  fillSecondary: "#EBEBE6",
  fillTertiary: "#F0F0EB",
  fillQuaternary: "#F5F5F0",
  strokePrimary: "#D0D0C8",
  strokeSecondary: "#DDDDD6",
  strokeTertiary: "#E6E6E0",
  strokeFocused: "#5E81AC",
  accent: "#5E81AC",
  buttonBackground: "#5E81AC",
  buttonForeground: "#FFFFFF",
  buttonHoverBackground: "#4C6C94",
  link: "#5E81AC",
  success: "#4C7A4A",
  danger: "#B42318",
  warning: "#B54708",
  info: "#175CD3",
};

export type TextTokens = {
  primary: string;
  secondary: string;
  tertiary: string;
  quaternary: string;
  link: string;
  onAccent: string;
};

export type SurfaceTokens = {
  editor: string;
  chrome: string;
  elevated: string;
};

export type FillTokens = {
  primary: string;
  secondary: string;
  tertiary: string;
  quaternary: string;
};

export type StrokeTokens = {
  primary: string;
  secondary: string;
  tertiary: string;
  focused: string;
};

export type AccentTokens = {
  primary: string;
  control: string;
};

export type CanvasTokens = {
  text: TextTokens;
  bg: SurfaceTokens;
  fill: FillTokens;
  stroke: StrokeTokens;
  accent: AccentTokens;
};

export type CanvasHostTheme = CanvasTokens & {
  kind: "dark" | "light";
  tokens: CanvasTokens;
  palette: CanvasPalette;
};

export function tokensFromPalette(palette: CanvasPalette): CanvasTokens {
  return {
    text: {
      primary: palette.foreground,
      secondary: palette.foregroundSecondary,
      tertiary: palette.foregroundTertiary,
      quaternary: palette.foregroundQuaternary,
      link: palette.link,
      onAccent: palette.buttonForeground,
    },
    bg: {
      editor: palette.editor,
      chrome: palette.chrome,
      elevated: palette.elevated,
    },
    fill: {
      primary: palette.fillPrimary,
      secondary: palette.fillSecondary,
      tertiary: palette.fillTertiary,
      quaternary: palette.fillQuaternary,
    },
    stroke: {
      primary: palette.strokePrimary,
      secondary: palette.strokeSecondary,
      tertiary: palette.strokeTertiary,
      focused: palette.strokeFocused,
    },
    accent: {
      primary: palette.accent,
      control: palette.buttonBackground,
    },
  };
}

export function themeFromKind(kind: "dark" | "light"): CanvasHostTheme {
  const palette = kind === "light" ? canvasPaletteLight : canvasPaletteDark;
  const tokens = tokensFromPalette(palette);
  return { kind, ...tokens, tokens, palette };
}

export function toneColor(theme: CanvasHostTheme, tone?: Tone | "success" | "danger" | "warning" | "info"): string {
  if (tone === "success") return theme.palette.success;
  if (tone === "danger") return theme.palette.danger;
  if (tone === "warning") return theme.palette.warning;
  if (tone === "info") return theme.palette.info;
  return theme.text.primary;
}

export const canvasTypography = {
  h1: { fontSize: "24px", lineHeight: "30px", fontWeight: 590 },
  h2: { fontSize: "18px", lineHeight: "24px", fontWeight: 590 },
  h3: { fontSize: "16px", lineHeight: "22px", fontWeight: 590 },
  body: { fontSize: "14px", lineHeight: "20px", fontWeight: 400 },
  small: { fontSize: "12px", lineHeight: "16px", fontWeight: 400 },
} as const;

export const chartPalette = ["#81A1C1", "#A3BE8C", "#EBCB8B", "#B48EAD", "#88C0D0", "#D08770", "#BF616A", "#8FBCBB"];
