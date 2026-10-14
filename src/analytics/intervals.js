import { weightedMean } from './comparator.js';

export const finite = value => typeof value === 'number' && Number.isFinite(value);
export const overlapSeconds = (start, end, row) => Math.max(0, Math.min(end, row.endSec) - Math.max(start, row.startSec));

// Each second contributes once. Conflicting overlaps are reported, never silently averaged.
export function measureWindow(rows, startSec, endSec, metric = 'share') {
  if (!finite(startSec) || !finite(endSec) || endSec <= startSec) throw new Error('Некорректное окно измерения');
  const relevant = rows.filter(row => overlapSeconds(startSec, endSec, row) > 0 && finite(row[metric]));
  const points = [...new Set([startSec, endSec, ...relevant.flatMap(row => [Math.max(startSec, row.startSec), Math.min(endSec, row.endSec)])])].sort((a, b) => a - b);
  const samples = []; let conflictSeconds = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i], end = points[i + 1];
    const active = relevant.filter(row => row.startSec <= start && row.endSec >= end);
    if (!active.length) continue;
    if (new Set(active.map(row => `${row.title ?? ''}\0${row[metric]}`)).size > 1) { conflictSeconds += end - start; continue; }
    samples.push({ value: active[0][metric], weight: end - start });
  }
  const coverageSeconds = samples.reduce((sum, row) => sum + row.weight, 0);
  return { value: weightedMean(samples), coverageSeconds, coverageFraction: coverageSeconds / (endSec - startSec), conflictSeconds,
    programs: [...new Set(relevant.map(row => row.title).filter(Boolean))] };
}
