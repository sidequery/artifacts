import type { CSSProperties, JSX } from "react";

import { useHostTheme } from "./hooks";
import { chartPalette, toneColor, type Tone } from "./tokens";
import { mergeStyle } from "./ui";

export type ChartTone = Tone;
export type ChartDataPoint = { label: string; value: number; tone?: ChartTone };
export type ChartSeries = { name: string; data: number[]; tone?: ChartTone };
export type ChartReferenceLine = { value: number; label?: string; tone?: ChartTone };

type ValueAxisProps = {
  beginAtZero?: boolean;
  yMin?: number;
  yMax?: number;
  referenceLines?: ChartReferenceLine[];
};

export type BarChartProps = ValueAxisProps & {
  categories: string[];
  series: ChartSeries[];
  height?: number;
  stacked?: boolean;
  horizontal?: boolean;
  valueSuffix?: string;
  valuePrefix?: string;
  style?: CSSProperties;
  caption?: string;
};

export type LineChartProps = ValueAxisProps & {
  categories: string[];
  series: ChartSeries[];
  height?: number;
  fill?: boolean;
  valueSuffix?: string;
  valuePrefix?: string;
  style?: CSSProperties;
  caption?: string;
};

export type PieChartProps = {
  data: ChartDataPoint[];
  size?: number;
  donut?: boolean;
  style?: CSSProperties;
  caption?: string;
};

export function BarChart({
  categories,
  series,
  height = 220,
  stacked,
  valueSuffix = "",
  valuePrefix = "",
  yMin,
  yMax,
  beginAtZero = true,
  style,
  caption,
}: BarChartProps): JSX.Element {
  const theme = useHostTheme();
  const width = Math.max(320, categories.length * 56);
  const pad = { top: 16, right: 16, bottom: 36, left: 40 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const max = yMax ?? Math.max(...series.flatMap((item) => item.data), 0);
  const min = yMin ?? (beginAtZero ? 0 : Math.min(...series.flatMap((item) => item.data), 0));
  const span = Math.max(max - min, 1);
  const groupWidth = plotW / Math.max(categories.length, 1);
  const barWidth = stacked ? groupWidth * 0.6 : (groupWidth * 0.7) / Math.max(series.length, 1);

  return (
    <figure style={mergeStyle({ margin: 0 }, style)}>
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img">
        {categories.map((category, index) => {
          const x0 = pad.left + index * groupWidth;
          return (
            <g key={category}>
              {stacked
                ? renderStacked(series, index, x0 + (groupWidth - barWidth) / 2, barWidth, pad.top, plotH, min, span, theme)
                : series.map((item, seriesIndex) => {
                    const value = item.data[index] ?? 0;
                    const barH = ((value - min) / span) * plotH;
                    const x = x0 + (groupWidth - barWidth * series.length) / 2 + seriesIndex * barWidth;
                    return (
                      <rect
                        key={item.name}
                        x={x}
                        y={pad.top + plotH - barH}
                        width={barWidth - 2}
                        height={Math.max(barH, 0)}
                        fill={seriesColor(item, seriesIndex, theme)}
                      />
                    );
                  })}
              <text
                x={x0 + groupWidth / 2}
                y={height - 12}
                textAnchor="middle"
                fill={theme.text.tertiary}
                fontSize="11"
              >
                {category}
              </text>
            </g>
          );
        })}
        <text x={4} y={14} fill={theme.text.tertiary} fontSize="10">
          {valuePrefix}
          {max}
          {valueSuffix}
        </text>
      </svg>
      {series.length > 1 ? <Legend series={series} /> : null}
      {caption ? <Caption text={caption} /> : null}
    </figure>
  );
}

export function LineChart({
  categories,
  series,
  height = 220,
  fill,
  yMin,
  yMax,
  beginAtZero = true,
  style,
  caption,
}: LineChartProps): JSX.Element {
  const theme = useHostTheme();
  const width = Math.max(320, categories.length * 56);
  const pad = { top: 16, right: 16, bottom: 36, left: 40 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const max = yMax ?? Math.max(...series.flatMap((item) => item.data), 0);
  const min = yMin ?? (beginAtZero ? 0 : Math.min(...series.flatMap((item) => item.data), 0));
  const span = Math.max(max - min, 1);
  const step = plotW / Math.max(categories.length - 1, 1);

  return (
    <figure style={mergeStyle({ margin: 0 }, style)}>
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img">
        {series.map((item, seriesIndex) => {
          const points = item.data.map((value, index) => {
            const x = pad.left + index * step;
            const y = pad.top + plotH - ((value - min) / span) * plotH;
            return `${x},${y}`;
          });
          const color = seriesColor(item, seriesIndex, theme);
          return (
            <g key={item.name}>
              {fill ? (
                <polygon
                  points={`${pad.left},${pad.top + plotH} ${points.join(" ")} ${pad.left + plotW},${pad.top + plotH}`}
                  fill={color}
                  opacity={0.15}
                />
              ) : null}
              <polyline points={points.join(" ")} fill="none" stroke={color} strokeWidth={2} />
            </g>
          );
        })}
        {categories.map((category, index) => (
          <text
            key={category}
            x={pad.left + index * step}
            y={height - 12}
            textAnchor="middle"
            fill={theme.text.tertiary}
            fontSize="11"
          >
            {category}
          </text>
        ))}
      </svg>
      {series.length > 1 ? <Legend series={series} /> : null}
      {caption ? <Caption text={caption} /> : null}
    </figure>
  );
}

export function PieChart({ data, size = 200, donut, style, caption }: PieChartProps): JSX.Element {
  const theme = useHostTheme();
  const total = data.reduce((sum, point) => sum + point.value, 0) || 1;
  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 8;
  const inner = donut ? radius * 0.55 : 0;
  let angle = -Math.PI / 2;

  const slices = data.map((point, index) => {
    const sweep = (point.value / total) * Math.PI * 2;
    const path = arcPath(cx, cy, radius, inner, angle, angle + sweep);
    angle += sweep;
    return { point, path, color: point.tone ? toneColor(theme, point.tone) : chartPalette[index % chartPalette.length] };
  });

  return (
    <figure style={mergeStyle({ margin: 0, display: "flex", gap: 16, alignItems: "center" }, style)}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img">
        {slices.map((slice) => (
          <path key={slice.point.label} d={slice.path} fill={slice.color} />
        ))}
        {donut ? (
          <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle" fill={theme.text.primary} fontSize="14">
            {total}
          </text>
        ) : null}
      </svg>
      <div>
        {data.map((point, index) => (
          <div key={point.label} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: theme.text.secondary }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 99,
                background: point.tone ? toneColor(theme, point.tone) : chartPalette[index % chartPalette.length],
              }}
            />
            {point.label}
          </div>
        ))}
        {caption ? <Caption text={caption} /> : null}
      </div>
    </figure>
  );
}

function renderStacked(
  series: ChartSeries[],
  index: number,
  x: number,
  barWidth: number,
  top: number,
  plotH: number,
  min: number,
  span: number,
  theme: ReturnType<typeof useHostTheme>,
) {
  let offset = 0;
  return series.map((item, seriesIndex) => {
    const value = item.data[index] ?? 0;
    const barH = ((value - min) / span) * plotH;
    const y = top + plotH - offset - barH;
    offset += barH;
    return (
      <rect
        key={item.name}
        x={x}
        y={y}
        width={barWidth}
        height={Math.max(barH, 0)}
        fill={seriesColor(item, seriesIndex, theme)}
      />
    );
  });
}

function seriesColor(series: ChartSeries, index: number, theme: ReturnType<typeof useHostTheme>): string {
  return series.tone ? toneColor(theme, series.tone) : chartPalette[index % chartPalette.length];
}

function Legend({ series }: { series: ChartSeries[] }): JSX.Element {
  const theme = useHostTheme();
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
      {series.map((item, index) => (
        <span key={item.name} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: theme.text.secondary }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 99,
              background: seriesColor(item, index, theme),
            }}
          />
          {item.name}
        </span>
      ))}
    </div>
  );
}

function Caption({ text }: { text: string }): JSX.Element {
  const theme = useHostTheme();
  return <figcaption style={{ marginTop: 8, fontSize: 11, color: theme.text.tertiary }}>{text}</figcaption>;
}

function arcPath(cx: number, cy: number, r: number, inner: number, start: number, end: number): string {
  const large = end - start > Math.PI ? 1 : 0;
  const x1 = cx + Math.cos(start) * r;
  const y1 = cy + Math.sin(start) * r;
  const x2 = cx + Math.cos(end) * r;
  const y2 = cy + Math.sin(end) * r;
  if (inner <= 0) {
    return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
  }
  const ix1 = cx + Math.cos(start) * inner;
  const iy1 = cy + Math.sin(start) * inner;
  const ix2 = cx + Math.cos(end) * inner;
  const iy2 = cy + Math.sin(end) * inner;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${ix2} ${iy2} A ${inner} ${inner} 0 ${large} 0 ${ix1} ${iy1} Z`;
}
