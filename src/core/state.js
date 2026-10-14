import { assertDateISO } from './normalization.js';

export const MODES = Object.freeze(['week', 'dayOfWeek', 'season', 'year']);
export const AUDIENCES = Object.freeze(['18-54', '25-34']);
export const INITIAL_STATE = Object.freeze({
  mode: 'week', audience: '18-54', dateFrom: null, dateTo: null,
  excludeNonWorkdays: false, selectedDayOfWeek: 4, selectedDate: null,
  periodA: null, periodB: null, busy: false, error: null, importProgress: null, revision: 0,
  view: 'overview', metric: 'share', chartView: 'daily', curveDates: [],
  programLayout: 'schedule', programQuery: '', programChannel: 'FTV (UZ/RU)',
  programDaypart: 'all', programSort: 'time', programPage: 1, selectedProgramId: null,
  dropRange: 'day',
});

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

function validate(value) {
  if (!MODES.includes(value.mode)) throw new Error('Неизвестный режим сравнения');
  if (!AUDIENCES.includes(value.audience)) throw new Error('Неизвестная аудитория');
  for (const [key, allowed] of Object.entries({
    view: ['overview', 'comparison', 'programs', 'grid', 'drops'], metric: ['share', 'rtg', 'reach', 'atsMin'],
    chartView: ['daily', 'slots', 'dayparts'], programLayout: ['schedule', 'catalog'],
    programDaypart: ['all', 'earlyMorning', 'morning', 'daytime', 'earlyFringe', 'primeTime', 'lateNight'],
    programSort: ['time', 'share', 'title'], dropRange: ['day', 'period'],
  })) if (!allowed.includes(value[key])) throw new Error(`Некорректное поле ${key}`);
  if (!Array.isArray(value.curveDates)) throw new Error('Ожидался массив дат');
  value.curveDates.forEach(assertDateISO);
  if (!Number.isInteger(value.programPage) || value.programPage < 1) throw new Error('Некорректная страница');
  for (const key of ['programQuery', 'programChannel']) if (typeof value[key] !== 'string') throw new Error(`Некорректное поле ${key}`);
  if (!Number.isInteger(value.selectedDayOfWeek) || value.selectedDayOfWeek < 1 || value.selectedDayOfWeek > 7) throw new Error('День недели должен быть от 1 до 7');
  for (const key of ['dateFrom', 'dateTo', 'selectedDate']) if (value[key] != null) assertDateISO(value[key]);
  if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) throw new Error('Начало периода позже конца');
  for (const key of ['excludeNonWorkdays', 'busy']) if (typeof value[key] !== 'boolean') throw new Error(`${key} должен быть boolean`);
}

export function createStore(initial = {}) {
  let value = { ...INITIAL_STATE, ...structuredClone(initial) };
  validate(value); value = freeze(value);
  const listeners = new Set();
  return {
    getState: () => value,
    setState(patch) {
      const changes = typeof patch === 'function' ? patch(value) : patch;
      for (const key of Object.keys(changes)) if (!(key in INITIAL_STATE)) throw new Error(`Неизвестное поле состояния: ${key}`);
      const next = { ...value, ...structuredClone(changes) };
      validate(next);
      if (Object.keys(changes).every(key => Object.is(next[key], value[key]))) return value;
      const previous = value;
      value = freeze(next);
      // Commit once, then notify every subscriber even when one callback fails.
      for (const listener of [...listeners]) {
        try { listener(value, previous); } catch (error) { globalThis.reportError?.(error); }
      }
      return value;
    },
    subscribe(listener, { immediate = false } = {}) {
      if (typeof listener !== 'function') throw new TypeError('Подписчик должен быть функцией');
      listeners.add(listener);
      if (immediate) listener(value, value);
      return () => listeners.delete(listener);
    },
    reset() { return this.setState(structuredClone(INITIAL_STATE)); },
  };
}

export const state = createStore();
