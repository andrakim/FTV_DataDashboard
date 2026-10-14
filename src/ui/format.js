export const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
export const WEEKDAY_NAMES = ['понедельники', 'вторники', 'среды', 'четверги', 'пятницы', 'субботы', 'воскресенья'];
export const METRIC_LABELS = { share: 'Доля', rtg: 'Рейтинг', reach: 'Охват', atsMin: 'Время просмотра' };
export const UNITS = { share: '%', rtg: '%', reach: '%', atsMin: 'мин' };
export const number = (value, digits = 2) => Number.isFinite(value) ? value.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
export const dateLabel = (dateISO, year = false) => dateISO ? new Date(`${dateISO}T00:00:00Z`).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' }) : '—';
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export const timeLabel = sec => Number.isFinite(sec) ? `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor(sec % 3600 / 60)).padStart(2, '0')}` : '—';
export const preciseTimeLabel = sec => Number.isFinite(sec) ? `${timeLabel(sec)}:${String(Math.floor(sec % 60)).padStart(2, '0')}` : '—';
export const metricValue = (value, metric) => `${number(value, metric === 'atsMin' || metric === 'reach' ? 1 : 2)} ${UNITS[metric]}`;
export function csvContent(rows) {
  return '\ufeff' + rows.map(row => row.map(value => {
    let text = String(value ?? '');
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }).join(';')).join('\r\n');
}
