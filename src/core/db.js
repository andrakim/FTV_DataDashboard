import { mergeRecord, assertDateISO } from './normalization.js';

export const DB_NAME = 'FTV_Analytics_DB';
export const DB_VERSION = 1;
export const STORES = Object.freeze(['daily_metrics', 'grid_10min', 'program_logs', 'media_scans']);
const KEYS = { daily_metrics: 'dateISO', grid_10min: 'id', program_logs: 'id', media_scans: 'dateISO' };

export class AnalyticsDB {
  constructor({ name = DB_NAME, indexedDB = globalThis.indexedDB, IDBKeyRange = globalThis.IDBKeyRange } = {}) {
    this.name = name;
    this.factory = indexedDB;
    this.keyRange = IDBKeyRange;
    this.connection = null;
    this.opening = null;
  }

  open() {
    if (this.connection) return Promise.resolve(this.connection);
    if (this.opening) return this.opening;
    if (!this.factory) return Promise.reject(new Error('IndexedDB недоступна в этом браузере'));
    this.opening = new Promise((resolve, reject) => {
      const request = this.factory.open(this.name, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of STORES) {
          const store = db.objectStoreNames.contains(name) ? request.transaction.objectStore(name) : db.createObjectStore(name, { keyPath: KEYS[name] });
          if (KEYS[name] !== 'dateISO' && !store.indexNames.contains('dateISO')) store.createIndex('dateISO', 'dateISO');
          if (name === 'program_logs' && !store.indexNames.contains('dateChannel')) store.createIndex('dateChannel', ['dateISO', 'channel']);
          if (name === 'daily_metrics') for (const index of ['year', 'seasonYear', 'dayOfWeek', 'isoWeekYear']) {
            if (!store.indexNames.contains(index)) store.createIndex(index, index);
          }
        }
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Обновление БД заблокировано: закройте другие вкладки приложения'));
      request.onsuccess = () => {
        this.connection = request.result;
        this.connection.onversionchange = () => this.close();
        resolve(this.connection);
      };
    }).finally(() => { this.opening = null; });
    return this.opening;
  }

  close() { this.connection?.close(); this.connection = null; }

  async get(store, key) {
    this.assertStore(store);
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store), request = tx.objectStore(store).get(key);
      let result;
      request.onsuccess = () => { result = request.result ?? null; };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error ?? request.error);
      tx.onerror = () => {}; // onabort is the final failure signal.
    });
  }

  async getAll(store, { from, to, dateISO, channel } = {}) {
    this.assertStore(store);
    for (const date of [from, to, dateISO]) if (date) assertDateISO(date);
    if (from && to && from > to) throw new Error('Начало периода позже конца');
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store), objectStore = tx.objectStore(store);
      const index = KEYS[store] === 'dateISO' ? objectStore : objectStore.index('dateISO');
      const lower = dateISO ?? from, upper = dateISO ?? to;
      const range = lower && upper ? this.keyRange.bound(lower, upper) : lower ? this.keyRange.lowerBound(lower) : upper ? this.keyRange.upperBound(upper) : undefined;
      const request = index.getAll(range);
      let result = [];
      request.onsuccess = () => { result = request.result.filter(row => !channel || row.channel === channel); };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error ?? request.error);
      tx.onerror = () => {};
    });
  }

  // All four stores commit atomically. Do not await inside the active transaction.
  async importReport(report) {
    assertDateISO(report.reportDateISO);
    const records = {};
    for (const store of STORES) {
      records[store] = report[store] ?? [];
      if (!Array.isArray(records[store])) throw new Error(`Ожидался массив ${store}`);
      for (const row of records[store]) {
        assertDateISO(row.dateISO);
        if (!row[KEYS[store]]) throw new Error(`Не задан ключ ${store}`);
      }
    }
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES, 'readwrite');
      const stats = Object.fromEntries(STORES.map(name => [name, { inserted: 0, updated: 0 }]));
      let failure;
      tx.oncomplete = () => resolve(stats);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('Импорт отменён'));
      tx.onerror = () => {};
      try {
        for (const name of STORES) {
          const store = tx.objectStore(name);
          // Fold duplicate keys before enqueueing reads, so parallel get callbacks cannot overwrite each other.
          const unique = new Map();
          for (const row of records[name]) unique.set(row[KEYS[name]], mergeRecord(unique.get(row[KEYS[name]]), row, { reportDateISO: report.reportDateISO, priority: 0 }));
          for (const row of unique.values()) {
            const request = store.get(row[KEYS[name]]);
            request.onsuccess = () => {
              try {
                store.put(mergeRecord(request.result, row, { reportDateISO: report.reportDateISO, priority: 0 }));
                stats[name][request.result ? 'updated' : 'inserted']++;
              } catch (error) { failure = error; tx.abort(); }
            };
          }
        }
      } catch (error) { failure = error; tx.abort(); }
    });
  }

  async loadData(filters = {}) {
    const [daily_metrics, grid_10min, program_logs] = await Promise.all([
      this.getAll('daily_metrics', filters), this.getAll('grid_10min', filters), this.getAll('program_logs', filters),
    ]);
    return { daily_metrics, grid_10min, program_logs };
  }

  async deleteDate(dateISO) {
    assertDateISO(dateISO);
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      for (const name of STORES) {
        const store = tx.objectStore(name);
        if (KEYS[name] === 'dateISO') store.delete(dateISO);
        else {
          const request = store.index('dateISO').openKeyCursor(this.keyRange.only(dateISO));
          request.onsuccess = () => {
            const cursor = request.result;
            if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); }
          };
        }
      }
    });
  }

  async clear() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      STORES.forEach(name => tx.objectStore(name).clear());
    });
  }

  assertStore(name) { if (!STORES.includes(name)) throw new Error(`Неизвестное хранилище: ${name}`); }
}

export const db = new AnalyticsDB();
