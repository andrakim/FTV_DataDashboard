import { BROADCAST_START, SLOT_SECONDS, DAYPARTS, normalizeChannel } from '../core/normalization.js';
import { weightedMean, mean } from './comparator.js';

export function buildProgramCatalog(data) {
  const exactIntervals = new Map();
  const exact = new Map();
  for (const row of data.program_logs ?? []) {
    if (!(row.endSec > row.startSec) || !row.title) continue;
    const channel = normalizeChannel(row.channel), id = row.id ?? `${row.dateISO}_${channel}_${row.startSec}`;
    const key = `${row.dateISO}_${channel}_${row.audience ?? '18-54'}`;
    if (!exactIntervals.has(key)) exactIntervals.set(key, []);
    exactIntervals.get(key).push(row);
    exact.set(id, { id, dateISO: row.dateISO, channel, title: row.title, startSec: row.startSec, endSec: row.endSec,
      durationMin: (row.endSec - row.startSec) / 60, share: row.share ?? null, rtg: row.rtg ?? null,
      audience: row.audience ?? '18-54', demographics: row.demographics ?? null, source: 'program_logs', approximate: false });
  }
  const groups = new Map();
  for (const slot of data.grid_10min ?? []) for (const [name, metrics] of Object.entries(slot.channels ?? {})) {
    const channel = normalizeChannel(name), key = `${slot.dateISO}_${channel}_${metrics.audience ?? '18-54'}`;
    if (!metrics.title) continue;
    const startSec = slot.startSec ?? BROADCAST_START + slot.slotIndex * SLOT_SECONDS;
    const endSec = slot.endSec ?? startSec + SLOT_SECONDS;
    if ((exactIntervals.get(key) ?? []).some(row => row.startSec < endSec && row.endSec > startSec)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...metrics, dateISO: slot.dateISO, channel, startSec, endSec });
  }
  const derived = [];
  for (const slots of groups.values()) {
    slots.sort((a, b) => a.startSec - b.startSec);
    let block;
    for (const slot of slots) {
      if (!block || block.endSec !== slot.startSec || block.title !== slot.title || block.audience !== (slot.audience ?? '18-54')) {
        block = { id: `grid_${slot.dateISO}_${slot.channel}_${slot.startSec}`, dateISO: slot.dateISO, channel: slot.channel,
          title: slot.title, startSec: slot.startSec, endSec: slot.endSec, audience: slot.audience ?? '18-54',
          source: 'grid_10min', approximate: true, samples: [] };
        derived.push(block);
      }
      block.endSec = slot.endSec;
      block.samples.push({ share: slot.share, rtg: slot.rtg, weight: slot.endSec - slot.startSec });
    }
  }
  for (const block of derived) {
    block.share = weightedMean(block.samples.map(row => ({ value: row.share, weight: row.weight })));
    block.rtg = weightedMean(block.samples.map(row => ({ value: row.rtg, weight: row.weight })));
    block.durationMin = (block.endSec - block.startSec) / 60;
    delete block.samples;
  }
  return [...exact.values(), ...derived].sort((a, b) => b.dateISO.localeCompare(a.dateISO) || a.startSec - b.startSec || a.channel.localeCompare(b.channel));
}

export function filterPrograms(catalog, { from, to, dateISO, channel, query = '', daypart = 'all', audience = '18-54', excludeNonWorkdays = false, workdays = new Map() } = {}) {
  const part = DAYPARTS.find(part => part.id === daypart);
  const search = query.trim().toLocaleLowerCase('ru');
  return catalog.filter(row => (!from || row.dateISO >= from) && (!to || row.dateISO <= to) && (!dateISO || row.dateISO === dateISO) &&
    (!channel || channel === 'all' || row.channel === normalizeChannel(channel)) && row.audience === audience &&
    (!search || row.title.toLocaleLowerCase('ru').includes(search)) && (!part || row.startSec < part.endSec && row.endSec > part.startSec) &&
    (!excludeNonWorkdays || workdays.get(row.dateISO) === true));
}

export function summarizePrograms(rows) {
  const groups = new Map();
  for (const row of rows) {
    const audience = row.audience ?? '18-54', source = row.source ?? (row.approximate ? 'grid_10min' : 'program_logs');
    const key = `${row.channel}\0${audience}\0${source}\0${row.title}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map(airings => {
    airings.sort((a, b) => b.dateISO.localeCompare(a.dateISO) || b.startSec - a.startSec);
    return { id: airings[0].id, title: airings[0].title, channel: airings[0].channel,
      audience: airings[0].audience ?? '18-54', source: airings[0].source ?? (airings[0].approximate ? 'grid_10min' : 'program_logs'), count: airings.length,
      dayCount: new Set(airings.map(row => row.dateISO)).size, durationMin: mean(airings.map(row => row.durationMin)),
      share: weightedMean(airings.map(row => ({ value: row.share, weight: row.durationMin }))),
      rtg: weightedMean(airings.map(row => ({ value: row.rtg, weight: row.durationMin }))),
      lastDate: airings[0].dateISO, approximateCount: airings.filter(row => row.approximate).length, airings };
  });
}

export function programNeighbors(catalog, program) {
  const rows = catalog.filter(row => row.dateISO === program.dateISO && row.channel === program.channel && row.audience === program.audience).sort((a, b) => a.startSec - b.startSec);
  const index = rows.findIndex(row => row.id === program.id);
  const previous = rows[index - 1], next = rows[index + 1];
  const adjacent = (a, b) => a && b && b.startSec >= a.endSec && b.startSec - a.endSec <= 600;
  return { previous: adjacent(previous, program) ? previous : null, next: adjacent(program, next) ? next : null };
}

export function programAtSlot(catalog, dateISO, channel, startSec) {
  const rows = catalog.filter(row => row.dateISO === dateISO && row.channel === channel && row.startSec < startSec + SLOT_SECONDS && row.endSec > startSec);
  return rows.find(row => row.startSec <= startSec + 300 && row.endSec > startSec + 300) ?? rows[0] ?? null;
}
