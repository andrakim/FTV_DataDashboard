import { QUERY_DEFAULTS, validateQuery, FIELD_LABELS, GROUPS, LABELS } from '../analytics/workspaceQuery.js';
import { assertDateISO as assertWorkspaceDate } from './normalization.js';

export const COLUMNS = Object.freeze({ dateISO: 'Дата', startSec: 'Время', title: 'Программа', channel: 'Канал', share: 'Доля', rtg: 'Рейтинг', viewers: 'Зрители',
  retention: 'Удержание входа', outRetention: 'Удержание выхода', previous: 'Перед программой', next: 'После программы', durationMin: 'Длительность', source: 'Источник', label: 'Метка', note: 'Заметка',
  ...Object.fromEntries(Object.entries(FIELD_LABELS).filter(([key]) => key.endsWith('Viewers'))) });
export const WORKSPACE_INITIAL = Object.freeze({ tab: 'research', view: 'table', query: structuredClone(QUERY_DEFAULTS),
  columns: ['dateISO', 'startSec', 'title', 'share', 'viewers', 'retention', 'previous', 'next', 'source'],
  selectedIds: [], focusedId: null, inspector: true, page: 1, metric: 'share', groupBy: 'title', statistic: 'mean',
  cohorts: { A: null, B: null }, saved: [], annotations: {}, contextMinutes: 15, competitors: ['SEVIMLI TV', "ZO'R TV (UZ/RU)", 'MILLIY TV', 'NAVO'],
  comparisonMode: 'cohorts', periodMode: 'week', periodA: '', periodB: '', periodView: 'daily', recurrenceDay: 4,
  periodMetric: 'share', regionMetric: 'share', curveDates: [], patternsMode: 'program', patternChannel: 'FTV (UZ/RU)',
  recurrenceSignal: 'leadIn', retentionThreshold: 70, baselineDropPercent: 20, recurrenceTitle: '', sidebar: false });

export function validateWorkspace(value) {
  validateQuery(value.query);
  for (const [key, allowed] of Object.entries({ tab: ['research', 'compare', 'patterns', 'data'], view: ['table', 'timeline', 'profile'],
    metric: Object.keys(FIELD_LABELS), groupBy: Object.keys(GROUPS), statistic: ['mean', 'median', 'weighted'], comparisonMode: ['cohorts', 'periods'],
    periodMode: ['week', 'dayOfWeek', 'season', 'year'], periodView: ['daily', 'slots', 'dayparts', 'regions'], periodMetric: ['share', 'rtg', 'reach', 'atsMin'], regionMetric: ['share', 'rtg', 'reach', 'atsMin', 'contribution', 'reach000', 'rtg000'], patternsMode: ['program', 'slot'], recurrenceSignal: ['leadIn', 'baseline'] })) if (!allowed.includes(value[key])) throw new Error(`Неверное поле рабочего пространства: ${key}`);
  for (const [key, allowed] of [['columns', COLUMNS], ['selectedIds', null], ['competitors', null]]) {
    if (!Array.isArray(value[key]) || value[key].some(item => typeof item !== 'string' || allowed && !Object.hasOwn(allowed, item)) || new Set(value[key]).size !== value[key].length) throw new Error(`Неверный список ${key}`);
  }
  if (!value.columns.length || !Number.isInteger(value.page) || value.page < 1) throw new Error('Неверные колонки или страница');
  if (!Number.isFinite(value.contextMinutes) || value.contextMinutes < 1 || value.contextMinutes > 240) throw new Error('Окно контекста 1–240 минут');
  if (!Number.isInteger(value.recurrenceDay) || value.recurrenceDay < 1 || value.recurrenceDay > 7) throw new Error('Выберите день недели');
  for (const key of ['retentionThreshold', 'baselineDropPercent']) if (!Number.isFinite(value[key]) || value[key] <= 0 || value[key] > 100) throw new Error('Порог 0–100%');
  for (const key of ['inspector', 'sidebar']) if (typeof value[key] !== 'boolean') throw new Error(`Неверное поле ${key}`);
  for (const key of ['focusedId', 'periodA', 'periodB', 'recurrenceTitle', 'patternChannel']) if (value[key] != null && typeof value[key] !== 'string') throw new Error(`Неверное поле ${key}`);
  if (!Array.isArray(value.curveDates)) throw new Error('Неверные даты кривых'); value.curveDates.forEach(assertWorkspaceDate);
  if (!Array.isArray(value.saved) || value.saved.length > 50) throw new Error('Не больше 50 исследований');
  for (const saved of value.saved) { if (typeof saved.id !== 'string' || typeof saved.name !== 'string' || !saved.name.trim() || saved.name.length > 100) throw new Error('Неверное исследование'); validateQuery(saved.query); }
  if (!value.cohorts || typeof value.cohorts !== 'object' || Array.isArray(value.cohorts)) throw new Error('Неверные наборы сравнения');
  for (const key of ['A', 'B']) {
    const cohort = value.cohorts?.[key];
    if (cohort != null && (!Array.isArray(cohort.ids) || cohort.ids.some(id => typeof id !== 'string') || new Set(cohort.ids).size !== cohort.ids.length || typeof cohort.name !== 'string' || !['18-54', '25-34'].includes(cohort.audience))) throw new Error('Неверный набор сравнения');
  }
  if (!value.annotations || typeof value.annotations !== 'object' || Array.isArray(value.annotations)) throw new Error('Неверные заметки');
  for (const item of Object.values(value.annotations)) if (!item || item.label && !Object.hasOwn(LABELS, item.label) || typeof item.note !== 'string' || item.note.length > 2000) throw new Error('Неверная заметка');
  return value;
}

export function restoreWorkspace(saved) {
  const value = { ...structuredClone(WORKSPACE_INITIAL), ...saved, query: { ...structuredClone(QUERY_DEFAULTS), ...saved?.query }, selectedIds: [], focusedId: null, sidebar: false };
  validateWorkspace(value); return value;
}

export function createQueryHistory(limit = 40) {
  const past = [], future = [];
  return { record(query) { past.push(structuredClone(query)); if (past.length > limit) past.shift(); future.length = 0; },
    undo(current) { if (!past.length) return null; future.push(structuredClone(current)); return past.pop(); },
    redo(current) { if (!future.length) return null; past.push(structuredClone(current)); return future.pop(); },
    get canUndo() { return past.length > 0; }, get canRedo() { return future.length > 0; } };
}

export function validateBackup(payload) {
  if (payload?.format !== 'FTV Studio backup' || payload.version !== 1 || !payload.data) throw new Error('Это не резервная копия FTV Studio');
  const restored = restoreWorkspace(payload.workspace || {});
  for (const store of ['daily_metrics', 'grid_10min', 'program_logs']) {
    if (!Array.isArray(payload.data[store])) throw new Error(`В копии отсутствует ${store}`);
    for (const row of payload.data[store]) {
      assertWorkspaceDate(row.dateISO);
      if (store !== 'daily_metrics' && typeof row.id !== 'string') throw new Error('В записи копии отсутствует ID');
      if (store === 'program_logs' && (typeof row.title !== 'string' || typeof row.channel !== 'string' || ![row.startSec, row.endSec].every(Number.isFinite) || row.startSec < 18000 || row.endSec > 104400 || row.endSec <= row.startSec)) throw new Error('Неверная программа в копии');
      if (store === 'grid_10min' && (!Number.isInteger(row.slotIndex) || row.slotIndex < 0 || row.slotIndex > 143 || !row.channels || typeof row.channels !== 'object')) throw new Error('Неверный слот в копии');
      if (store === 'daily_metrics' && row.isWorkday != null && typeof row.isWorkday !== 'boolean') throw new Error('Неверный тип дня в копии');
      const metrics = store === 'daily_metrics' ? [row.ftv_18_54, row.ftv_25_34] : store === 'grid_10min' ? Object.values(row.channels) : [row];
      for (const metric of metrics.filter(Boolean)) for (const key of ['share', 'rtg', 'reach', 'atsMin']) if (metric[key] != null && !Number.isFinite(metric[key])) throw new Error('Неверная метрика в копии');
    }
  }
  return restored;
}
