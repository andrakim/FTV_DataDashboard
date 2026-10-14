import {
  BROADCAST_START, SLOT_SECONDS, FTV_CHANNEL, dailyRecord, mergeRecord,
  normalizeChannel, parseNumber, parseReportDate, parseBroadcastTime,
} from '../core/normalization.js';

export { parseBroadcastTime, parseReportDate, parseNumber } from '../core/normalization.js';
export const PROGRAM_CELL_REGEX = /^(?<title>.+?)\s*\/\s*(?:N\/A\s*\/\s*)?Share=(?<share>[\d.,]+)\s*\/\s*Rtg%=(?<rtg>[\d.,]+)$/;
const MAPPED_SHEETS = ['СОДЕРЖАНИЕ', 'FTV_60 дней', 'Сетка_FTV_каналы', 'Сетка_FTV_неделя', 'TOP_FTV', 'TOP_каналы', 'Аудитория', 'Доля', 'Охват', 'Время', 'Вклад регионов'];

export function parseProgramCell(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const match = text.match(PROGRAM_CELL_REGEX);
  if (!match) return null;
  const share = parseNumber(match.groups.share), rtg = parseNumber(match.groups.rtg);
  if (share == null || rtg == null) return null;
  return { title: match.groups.title.trim(), share, rtg, audience: '18-54' };
}

function encodeColumn(column) {
  let value = column + 1, text = '';
  while (value > 0) { value--; text = String.fromCharCode(65 + value % 26) + text; value = Math.floor(value / 26); }
  return text;
}
const address = (row, col) => `${encodeColumn(col)}${row + 1}`;
const cell = (sheet, row, col) => sheet?.[address(row, col)]?.v;
function lastRow(sheet) {
  const ref = sheet?.['!ref']?.split(':').at(-1);
  return ref ? Number(ref.match(/\d+$/)?.[0] ?? 0) : 0;
}

// Clone cells as well as the worksheet: parsing must not modify the caller's workbook.
export function unmergeWorksheet(sheet) {
  const output = { ...sheet };
  for (const range of sheet?.['!merges'] ?? []) {
    const topLeft = sheet[address(range.s.r, range.s.c)];
    if (!topLeft) continue;
    for (let row = range.s.r; row <= range.e.r; row++) {
      for (let col = range.s.c; col <= range.e.c; col++) output[address(row, col)] = { ...topLeft };
    }
  }
  output['!merges'] = [];
  return output;
}

export function parseWorkbook(workbook, { preserveAdditionalSheets = true } = {}) {
  if (!workbook?.Sheets) throw new Error('Некорректная книга Excel');
  const warnings = [];
  const dateOptions = { date1904: Boolean(workbook.Workbook?.WBProps?.date1904) };
  const parseDate = value => parseReportDate(value, dateOptions);
  const sheets = workbook.Sheets;
  const dates = [];
  for (const [name, ref] of [['СОДЕРЖАНИЕ', 'F1'], ['Сетка_FTV_каналы', 'C2'], ['Доля', 'B2']]) {
    const value = sheets[name]?.[ref]?.v;
    if (value == null) continue;
    try { dates.push({ source: `${name}!${ref}`, dateISO: parseDate(value) }); }
    catch (error) { warnings.push(`${name}!${ref}: ${error.message}`); }
  }
  if (!dates.length) throw new Error('Отчётная дата не найдена в СОДЕРЖАНИЕ!F1, Сетка_FTV_каналы!C2 или Доля!B2');
  const reportDateISO = dates[0].dateISO;
  for (const candidate of dates) if (candidate.dateISO !== reportDateISO) warnings.push(`Даты не совпадают: ${candidate.source}=${candidate.dateISO}; отчёт=${reportDateISO}`);
  const daily = new Map(), grid = new Map(), logs = new Map();
  const source = (sheet, priority) => ({ reportDateISO, sheet, priority });
  const addDaily = (dateISO, patch, sheet, priority) => daily.set(dateISO, mergeRecord(daily.get(dateISO) ?? dailyRecord(dateISO), { dateISO, ...patch }, source(sheet, priority)));
  const safe = (sheet, row, action) => {
    try { action(); } catch (error) { warnings.push(`${sheet}, строка ${row}: ${error.message}`); }
  };
  for (const name of MAPPED_SHEETS) if (!sheets[name]) warnings.push(`Лист «${name}» отсутствует`);
  addDaily(reportDateISO, {}, 'СОДЕРЖАНИЕ', 10);

  const history = sheets['FTV_60 дней'];
  if (history) {
    // AF/AG is a separate calendar table; never assume its dates align with B.
    const workdays = new Map();
    for (let r = 4; r < lastRow(history); r++) {
      const dateValue = cell(history, r, 31), flag = String(cell(history, r, 32) ?? '').trim().toLowerCase();
      if (dateValue == null || !flag) continue;
      safe('FTV_60 дней (AF/AG)', r + 1, () => {
        const isWorkday = /^(нерабочий|нерабочая|выходной|праздничный)$/.test(flag) ? false : /^(рабочий|рабочая)$/.test(flag) ? true : null;
        if (isWorkday == null) warnings.push(`Неизвестный тип дня: ${flag}`);
        workdays.set(parseDate(dateValue), isWorkday);
      });
    }
    for (let r = 4; r < lastRow(history); r++) {
      if (cell(history, r, 1) == null) continue;
      safe('FTV_60 дней', r + 1, () => {
        const dateISO = parseDate(cell(history, r, 1));
        const metrics = col => Object.fromEntries(['share', 'rtg', 'reach', 'atsMin'].map((key, i) => [key, parseNumber(cell(history, r, col + i))]));
        addDaily(dateISO, { ftv_18_54: metrics(2), ftv_25_34: metrics(6), isWorkday: workdays.get(dateISO) ?? null }, 'FTV_60 дней', 40);
      });
    }
  }

  function parseGrid(name, weekly) {
    const sheet = sheets[name] && unmergeWorksheet(sheets[name]);
    if (!sheet) return;
    const gridDateISO = weekly ? null : (dates.find(d => d.source === 'Сетка_FTV_каналы!C2')?.dateISO ?? reportDateISO);
    const columns = [];
    for (let c = 2; c <= (weekly ? 9 : 8); c++) {
      safe(name, 3, () => {
        const header = cell(sheet, 2, c);
        if (header == null) return;
        const dateISO = weekly ? parseDate(header) : gridDateISO;
        const channel = weekly ? FTV_CHANNEL : normalizeChannel(header);
        columns.push({ c, dateISO, channel });
        const share = parseNumber(cell(sheet, 3, c));
        addDaily(dateISO, channel === FTV_CHANNEL ? { ftv_18_54: { share } } : { competitorsDaily: { [channel]: { share, audience: '18-54' } } }, name, 20);
      });
    }
    for (let r = 5; r <= 148; r++) {
      const slotIndex = r - 5, expectedStart = BROADCAST_START + slotIndex * SLOT_SECONDS;
      const interval = cell(sheet, r, 1);
      let validInterval = true;
      if (interval != null) safe(name, r + 1, () => {
        const match = String(interval).match(/^\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*[-–—]\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*$/);
        try {
          if (!match || parseBroadcastTime(match[1]).totalSeconds !== expectedStart || parseBroadcastTime(match[2]).totalSeconds !== expectedStart + SLOT_SECONDS) throw new Error();
        } catch { validInterval = false; throw new Error(`Неверный интервал слота: ${interval}`); }
      });
      if (!validInterval) continue;
      for (const { c, dateISO, channel } of columns) {
        const id = `${dateISO}_${slotIndex}`;
        const parsed = parseProgramCell(cell(sheet, r, c));
        if (!parsed && cell(sheet, r, c) != null && String(cell(sheet, r, c)).trim()) warnings.push(`${name}!${address(r, c)}: неверный формат программы`);
        const row = { id, dateISO, slotIndex, startSec: expectedStart, endSec: expectedStart + SLOT_SECONDS, channels: parsed ? { [channel]: parsed } : {} };
        grid.set(id, mergeRecord(grid.get(id), row, source(name, weekly ? 20 : 30)));
      }
    }
  }
  parseGrid('Сетка_FTV_неделя', true);
  parseGrid('Сетка_FTV_каналы', false);

  for (const name of ['TOP_каналы', 'TOP_FTV']) {
    const sheet = sheets[name];
    if (!sheet) continue;
    for (let r = 3; r < lastRow(sheet); r++) {
      if (cell(sheet, r, 0) == null) continue;
      safe(name, r + 1, () => {
        const dateISO = parseDate(cell(sheet, r, 0));
        const startSec = parseBroadcastTime(cell(sheet, r, 1)).totalSeconds;
        const endSec = parseBroadcastTime(cell(sheet, r, 2)).totalSeconds;
        const channel = normalizeChannel(cell(sheet, r, 3)), title = String(cell(sheet, r, 4) ?? '').trim();
        if (endSec <= startSec || !channel || !title) throw new Error('Некорректные границы или название программы');
        const id = `${dateISO}_${channel}_${startSec}`;
        const row = { id, dateISO, channel, title, startSec, endSec, durationMin: (endSec - startSec) / 60,
          rtg: parseNumber(cell(sheet, r, 5)), share: parseNumber(cell(sheet, r, 6)), audience: '18-54' };
        logs.set(id, mergeRecord(logs.get(id), row, source(name, name === 'TOP_FTV' ? 40 : 30)));
      });
    }
  }

  const audience = sheets['Аудитория'];
  if (audience) for (let r = 3; r < lastRow(audience); r++) {
    if (cell(audience, r, 2) == null) continue;
    safe('Аудитория', r + 1, () => {
      const dateISO = parseDate(cell(audience, r, 2)), channel = normalizeChannel(cell(audience, r, 0));
      const startSec = parseBroadcastTime(cell(audience, r, 3)).totalSeconds;
      const id = `${dateISO}_${channel}_${startSec}`;
      const segments = {};
      for (const [gender, startCol] of [['M', 6], ['W', 11]]) ['18-24', '25-34', '35-44', '45-54'].forEach((age, i) => { segments[`${gender} ${age}`] = parseNumber(cell(audience, r, startCol + i)); });
      const demographics = { unit: 'thousandViewers', total: parseNumber(cell(audience, r, 4)), male: parseNumber(cell(audience, r, 5)), female: parseNumber(cell(audience, r, 10)), segments };
      if (!logs.has(id)) { warnings.push(`Аудитория, строка ${r + 1}: нет соответствующей программы ${id}`); return; }
      logs.set(id, mergeRecord(logs.get(id), { id, demographics }, source('Аудитория', 40)));
    });
  }

  for (const [name, metric] of [['Доля', 'share'], ['Охват', 'reach'], ['Время', 'atsMin']]) {
    const sheet = sheets[name];
    if (!sheet) continue;
    const audienceText = String(sheet.B3?.v ?? '18-54');
    const audienceKey = audienceText.includes('25-34') ? 'ftv_25_34' : 'ftv_18_54';
    const summaryAudience = audienceText.includes('25-34') ? '25-34' : '18-54';
    // Row 5 contains OTHER CHANNELS in real reports; keep it as well.
    for (let r = 4; r < lastRow(sheet); r++) {
      const channel = normalizeChannel(cell(sheet, r, 0)), value = parseNumber(cell(sheet, r, 1));
      if (!channel || value == null) continue;
      addDaily(reportDateISO, channel === FTV_CHANNEL ? { [audienceKey]: { [metric]: value } } :
        { competitorsDaily: { [channel]: { [metric]: value, audience: summaryAudience } } }, name, 30);
    }
  }

  const regions = sheets['Вклад регионов'] && unmergeWorksheet(sheets['Вклад регионов']);
  if (regions) {
    let channel = '', target = '';
    for (let r = 3; r < lastRow(regions); r++) {
      channel = normalizeChannel(cell(regions, r, 0)) || channel;
      target = String(cell(regions, r, 1) ?? '').trim() || target;
      const region = String(cell(regions, r, 2) ?? '').trim();
      if (channel !== FTV_CHANNEL || !target || !region) continue;
      const targetKey = target.includes('18-54') ? '18-54' : target.includes('25-34') ? '25-34' : target;
      const values = Object.fromEntries(['share', 'rtg', 'reach000', 'reach', 'atsMin', 'rtg000'].map((key, i) => [key, parseNumber(cell(regions, r, 3 + i))]));
      values.contribution = parseNumber(cell(regions, r, 10));
      addDaily(reportDateISO, { regions: { [targetKey]: { [region]: values } } }, 'Вклад регионов', 40);
    }
  }

  const sheetNames = workbook.SheetNames ?? Object.keys(sheets);
  const sheetInventory = sheetNames.map((name, i) => ({ name, hidden: workbook.Workbook?.Sheets?.[i]?.Hidden ?? 0, range: sheets[name]?.['!ref'] ?? null, mapped: MAPPED_SHEETS.includes(name) }));
  if (preserveAdditionalSheets) {
    const additionalSheets = {};
    for (const { name, mapped } of sheetInventory) if (!mapped) {
      const sheet = unmergeWorksheet(sheets[name]);
      const cells = {};
      for (const [ref, value] of Object.entries(sheet)) if (!ref.startsWith('!') && value?.v != null) cells[ref] = { value: value.v, type: value.t ?? null };
      additionalSheets[name] = { range: sheet['!ref'] ?? null, cells };
    }
    addDaily(reportDateISO, { additionalSheets }, 'additionalSheets', 10);
  }
  return {
    reportDateISO, daily_metrics: [...daily.values()].sort((a, b) => a.dateISO.localeCompare(b.dateISO)),
    grid_10min: [...grid.values()].sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.slotIndex - b.slotIndex),
    program_logs: [...logs.values()].sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.channel.localeCompare(b.channel) || a.startSec - b.startSec),
    media_scans: [], warnings, metadata: { sheetInventory, dateSources: dates, gridAudience: '18-54', programAudience: '18-54' },
  };
}

export async function parseExcelFile(input, { XLSX = globalThis.XLSX, JSZip = globalThis.JSZip, ...options } = {}) {
  if (!XLSX?.read) throw new Error('SheetJS не загружен');
  if (!JSZip?.loadAsync) throw new Error('JSZip не загружен');
  const bytes = input instanceof ArrayBuffer ? input : ArrayBuffer.isView(input) ? input : await input.arrayBuffer();
  // cellDates:false preserves exact [h]:mm:ss serials rather than losing the +1 day.
  const workbook = XLSX.read(bytes, { type: 'array', cellDates: false, cellNF: true });
  const result = parseWorkbook(workbook, options);
  const archive = await JSZip.loadAsync(bytes);
  const scan = archive.file('xl/media/image3.png');
  if (scan) {
    const blob = new Blob([await scan.async('uint8array')], { type: 'image/png' });
    result.media_scans.push(mergeRecord(null, { dateISO: result.reportDateISO, blob, path: 'xl/media/image3.png' }, { reportDateISO: result.reportDateISO, priority: 40 }));
  } else result.warnings.push('Скан xl/media/image3.png отсутствует');
  return result;
}
