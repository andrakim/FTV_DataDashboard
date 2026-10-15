import { TREND_DEFAULTS, validateTrendFilters } from '../analytics/trendExplorer.js';

export const SIMPLE_VIEW_INITIAL = Object.freeze({ tab: 'trend', filters: structuredClone(TREND_DEFAULTS), scale: 'fit', page: 1 });
export function validateSimpleView(value) {
  if (!['trend', 'programmes', 'periods', 'data'].includes(value.tab) || !['fit', 'large', 'larger'].includes(value.scale) || !Number.isInteger(value.page) || value.page < 1) throw new Error('Неверное представление.');
  validateTrendFilters(value.filters); return value;
}
export function restoreSimpleView(saved) {
  const value = { ...structuredClone(SIMPLE_VIEW_INITIAL), ...saved, filters: { ...structuredClone(TREND_DEFAULTS), ...saved?.filters } };
  validateSimpleView(value); return value;
}
