import sharp from 'sharp';
import type { GuildConfig } from '../domain/types.js';
import { crosschannelAllowedWindowSeconds } from './duplicateDetector.js';
import { formatDurationSeconds } from './duration.js';

export type CrosschannelCurveImage = {
  filename: string;
  buffer: Buffer;
};

const width = 1400;
const height = 820;
const margin = { top: 74, right: 36, bottom: 96, left: 96 };
const plotWidth = width - margin.left - margin.right;
const plotHeight = height - margin.top - margin.bottom;

export async function renderCrosschannelCurveImage(
  config: GuildConfig,
): Promise<CrosschannelCurveImage> {
  const svg = crosschannelCurveSvg(config);
  return {
    filename: 'honeybot-crosschannel-curve.png',
    buffer: await sharp(Buffer.from(svg)).png().toBuffer(),
  };
}

export function crosschannelCurveSvg(config: GuildConfig) {
  const xMin = 2;
  const xMaxExclusive = Math.max(
    xMin + 1,
    config.crosschannelWindowMidpointChannels * 2.5,
  );
  const xMaxPoint = Math.max(xMin, Math.ceil(xMaxExclusive) - 1);
  const yMax = config.crosschannelWindowSeconds * 1.1;
  const labeledPoints = Array.from(
    { length: xMaxPoint - xMin + 1 },
    (_, index) => xMin + index,
  ).map((channelCount) => ({
    channelCount,
    seconds: Math.round(crosschannelAllowedWindowSeconds(channelCount, config)),
  }));
  const curvePoints = Array.from({ length: 240 }, (_, index) => {
    const ratio = index / 239;
    const channelCount = xMin + (xMaxExclusive - xMin) * ratio;
    return {
      channelCount,
      seconds: crosschannelAllowedWindowSeconds(channelCount, config),
    };
  });

  const x = (channelCount: number) =>
    margin.left + ((channelCount - xMin) / (xMaxExclusive - xMin)) * plotWidth;
  const y = (seconds: number) =>
    margin.top + plotHeight - (seconds / yMax) * plotHeight;

  const path = curvePoints
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'} ${x(point.channelCount).toFixed(2)} ${y(point.seconds).toFixed(2)}`,
    )
    .join(' ');
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) =>
    Math.round(yMax * ratio),
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#111827"/>
  <rect x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}" rx="18" fill="#0f172a" stroke="#334155" stroke-width="2"/>
  <text x="${margin.left}" y="38" fill="#facc15" font-family="Inter, Arial, sans-serif" font-size="28" font-weight="700">Cross-channel detection window</text>
  <text x="${margin.left}" y="64" fill="#cbd5e1" font-family="Inter, Arial, sans-serif" font-size="17">x: 2 ≤ channels &lt; ${formatNumber(xMaxExclusive)} · y: 0 ≤ seconds &lt; ${formatDurationSeconds(Math.round(yMax))}</text>

  ${yTicks
    .map(
      (tick) => `
  <line x1="${margin.left}" y1="${y(tick).toFixed(2)}" x2="${margin.left + plotWidth}" y2="${y(tick).toFixed(2)}" stroke="#1e293b" stroke-width="1"/>
  <text x="${margin.left - 12}" y="${(y(tick) + 5).toFixed(2)}" fill="#94a3b8" font-family="Inter, Arial, sans-serif" font-size="14" text-anchor="end">${formatDurationSeconds(tick)}</text>`,
    )
    .join('')}

  ${labeledPoints
    .map(
      (point) => `
  <line x1="${x(point.channelCount).toFixed(2)}" y1="${margin.top}" x2="${x(point.channelCount).toFixed(2)}" y2="${margin.top + plotHeight}" stroke="#1e293b" stroke-width="1"/>
  <text x="${x(point.channelCount).toFixed(2)}" y="${height - 42}" fill="#94a3b8" font-family="Inter, Arial, sans-serif" font-size="13" text-anchor="middle">${point.channelCount}</text>`,
    )
    .join('')}

  <line x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${margin.left + plotWidth}" y2="${margin.top + plotHeight}" stroke="#64748b" stroke-width="2"/>
  <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotHeight}" stroke="#64748b" stroke-width="2"/>
  <text x="${margin.left + plotWidth / 2}" y="${height - 16}" fill="#cbd5e1" font-family="Inter, Arial, sans-serif" font-size="16" text-anchor="middle">Distinct channels</text>
  <text x="28" y="${margin.top + plotHeight / 2}" fill="#cbd5e1" font-family="Inter, Arial, sans-serif" font-size="16" text-anchor="middle" transform="rotate(-90 28 ${margin.top + plotHeight / 2})">Allowed seconds</text>
  <path d="${path}" fill="none" stroke="#facc15" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>

  ${labeledPoints
    .map((point) => {
      const pointX = x(point.channelCount);
      const pointY = y(point.seconds);
      const aboveLine =
        point.channelCount < config.crosschannelWindowMidpointChannels;
      const midpointDistance = Math.abs(
        point.channelCount - config.crosschannelWindowMidpointChannels,
      );
      const angleBand = Math.max(
        2,
        config.crosschannelWindowMidpointChannels * 0.45,
      );
      const midpointCloseness = Math.max(0, 1 - midpointDistance / angleBand);
      const label = `${point.channelCount}ch · ${formatDurationSeconds(point.seconds)}`;
      const labelWidth = Math.max(54, label.length * 6.4);
      const lane = aboveLine
        ? (point.channelCount - xMin) % 4
        : (xMaxPoint - point.channelCount) % 4;
      const labelGap =
        28 + lane * 16 + midpointCloseness * 12 + (aboveLine ? 0 : 10);
      const xShift = midpointCloseness * (labelWidth * 0.38 + 12);
      const minLabelX = margin.left + labelWidth / 2 + 6;
      const maxLabelX = margin.left + plotWidth - labelWidth / 2 - 6;
      const targetLabelX = pointX + (aboveLine ? -xShift : xShift);
      const labelX = Math.min(maxLabelX, Math.max(minLabelX, targetLabelX));
      const labelY = pointY + (aboveLine ? -labelGap : labelGap);
      const rectX = -(labelWidth + 12) / 2;
      return `
  <line x1="${pointX.toFixed(2)}" y1="${pointY.toFixed(2)}" x2="${labelX.toFixed(2)}" y2="${labelY.toFixed(2)}" stroke="#475569" stroke-width="1" stroke-linecap="round"/>
  <circle cx="${pointX.toFixed(2)}" cy="${pointY.toFixed(2)}" r="6" fill="#fde68a" stroke="#92400e" stroke-width="2"/>
  <g transform="translate(${labelX.toFixed(2)} ${labelY.toFixed(2)})">
    <rect x="${rectX.toFixed(2)}" y="-10" width="${(labelWidth + 12).toFixed(2)}" height="20" rx="5" fill="#0f172a" fill-opacity="0.88" stroke="#1e293b" stroke-width="1"/>
    <text x="0" y="1" fill="#e2e8f0" font-family="Inter, Arial, sans-serif" font-size="11" font-weight="700" text-anchor="middle" dominant-baseline="middle">${label}</text>
  </g>`;
    })
    .join('')}
</svg>`;
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
