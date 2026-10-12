export const MAX_TIMELINE_TIME_PER_DIV_MS = 100_000;
export const TIMELINE_TIME_PRESETS_MS = [
  2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 30000, 60000, 75000,
  MAX_TIMELINE_TIME_PER_DIV_MS,
];

/** Also clamps view settings restored from older CSVs or workspace state. */
export function clampTimelineTimePerDiv(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(value, MAX_TIMELINE_TIME_PER_DIV_MS) : 100;
}

export function parseTimelineTimePerDiv(text: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d*)?|\.\d+)\s*(ms|s)?\s*$/i.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]) * (match[2]?.toLowerCase() === 's' ? 1000 : 1);
  return Number.isFinite(value) && value > 0 ? clampTimelineTimePerDiv(value) : undefined;
}
