// Shared pure conversions. No browser, database or UI dependencies.
export const FTV_CHANNEL = 'FTV (UZ/RU)';
export const BROADCAST_START = 5 * 3600;
export const BROADCAST_END = 29 * 3600;
export const SLOT_SECONDS = 600;
export const DAYPARTS = Object.freeze([
  { id: 'earlyMorning', label: 'Раннее утро', startSec: 18000, endSec: 21600 },
  { id: 'morning', label: 'Утро', startSec: 21600, endSec: 39600 },
  { id: 'daytime', label: 'День', startSec: 39600, endSec: 61200 },
  { id: 'earlyFringe', label: 'Предпрайм', startSec: 61200, endSec: 68400 },
  { id: 'primeTime', label: 'Прайм-тайм', startSec: 68400, endSec: 82800 },
  { id: 'lateNight', label: 'Поздний вечер / ночь', startSec: 82800, endSec: 104400 },
]);

export function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value == null || typeof value === 'boolean') return null;
  const normalized = String(value).trim().replace(/[\s\u00a0]/g, '').replace(/,/g, '.').replace(/%$/, '');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;
  return Number.parseFloat(normalized);
}

export function normalizeChannel(value) {
  return String(value ?? '').trim().replace(/[`’‘ʼ]/g, "'").replace(/\s+/g, ' ');
}

export function parseReportDate(value, { date1904 = false } = {}) {
  let date;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('Некорректная дата Excel');
    date = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    const day = Math.floor(value);
    // Excel's fictitious 1900-02-29 is deliberately rejected.
    if (!date1904 && day === 60) throw new Error('Несуществующая дата Excel 29.02.1900');
    const epoch = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 31);
    date = new Date(epoch + (day - (!date1904 && day > 60 ? 1 : 0)) * 86400000);
  } else {
    const text = String(value ?? '').trim();
    const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const dmy = text.match(/(?:^|\s)(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s|$)/);
    if (!iso && !dmy) throw new Error(`Некорректная дата: ${text}`);
    const [y, m, d] = iso ? [Number(iso[1]), Number(iso[2]), Number(iso[3])] : [Number(dmy[3]), Number(dmy[2]), Number(dmy[1])];
    date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) throw new Error(`Несуществующая дата: ${text}`);
  }
  if (!Number.isFinite(date.getTime())) throw new Error('Некорректная дата Excel');
  return date.toISOString().slice(0, 10);
}

export function dateDimensions(dateISO) {
  const date = new Date(`${parseReportDate(dateISO)}T00:00:00Z`);
  const year = date.getUTCFullYear(), month = date.getUTCMonth() + 1;
  const dayOfWeek = date.getUTCDay() || 7;
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + 4 - dayOfWeek);
  const isoWeekYear = thursday.getUTCFullYear();
  const isoWeek = Math.ceil(((thursday - Date.UTC(isoWeekYear, 0, 1)) / 86400000 + 1) / 7);
  const season = month === 12 || month < 3 ? 'winter' : month < 6 ? 'spring' : month < 9 ? 'summer' : 'autumn';
  // Winter is labelled by the year of January/February (December belongs to next winter).
  return { year, month, season, seasonYear: season === 'winter' && month === 12 ? year + 1 : year, isoWeek, isoWeekYear, dayOfWeek };
}

export function assertDateISO(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || parseReportDate(value) !== value) {
    throw new Error('Дата должна быть в формате YYYY-MM-DD');
  }
  return value;
}

export function formatBroadcastTime(seconds, clock = false) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Некорректное эфирное время');
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = Math.floor(seconds % 60);
  const text = [clock ? h % 24 : h, m, s].map(v => String(v).padStart(2, '0')).join(':');
  return `${text}${clock && h >= 24 ? ' (+1)' : ''}`;
}

export function parseBroadcastTime(value, { clock = false } = {}) {
  let seconds;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // SheetJS raw time cells use fractions of a day; [h]:mm may exceed one day.
    if (value < 0 || value > 29 / 24) throw new Error(`Некорректное время Excel: ${value}`);
    seconds = Math.round(value * 86400);
  } else if (value instanceof Date) {
    seconds = value.getUTCHours() * 3600 + value.getUTCMinutes() * 60 + value.getUTCSeconds();
  } else {
    const match = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!match || +match[2] > 59 || +(match[3] ?? 0) > 59) throw new Error(`Некорректное эфирное время: ${value}`);
    seconds = +match[1] * 3600 + +match[2] * 60 + +(match[3] ?? 0);
  }
  if (!Number.isFinite(seconds)) throw new Error('Некорректное эфирное время');
  if (seconds < BROADCAST_START) seconds += 86400;
  if (seconds < BROADCAST_START || seconds > BROADCAST_END) throw new Error(`Время вне эфирных суток: ${value}`);
  const part = DAYPARTS.find(p => seconds >= p.startSec && seconds < p.endSec);
  return { totalSeconds: seconds, displayTime: formatBroadcastTime(seconds, clock), daypart: part?.id ?? null };
}

export function dailyRecord(dateISO) {
  return { dateISO, ...dateDimensions(dateISO), isWorkday: null, ftv_18_54: {}, ftv_25_34: {}, competitorsDaily: {}, regions: {} };
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Blob) && !(value instanceof Date);

// Field-level provenance makes overlapping reports independent of import order.
// Missing values never erase measured zeros or existing competitor/demographic data.
export function mergeRecord(existing, incoming, source = { reportDateISO: '', priority: 0 }) {
  const result = structuredClone(existing ?? {});
  const fieldSources = { ...(result._fieldSources ?? {}) };
  function merge(target, patch, prefix = '') {
    for (const [key, value] of Object.entries(patch)) {
      if (key === '_fieldSources' || value == null) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (object(value)) {
        if (!object(target[key])) target[key] = {};
        merge(target[key], value, path);
      } else {
        const next = incoming._fieldSources?.[path] ?? source;
        const old = fieldSources[path];
        if (target[key] == null || !old || next.priority > old.priority || (next.priority === old.priority && next.reportDateISO >= old.reportDateISO)) {
          target[key] = structuredClone(value);
          fieldSources[path] = next;
        }
      }
    }
  }
  merge(result, incoming);
  result._fieldSources = fieldSources;
  return result;
}
