import { parseExcelFile } from '../parser/excelParser.js';

export function createImportClient() {
  let worker, counter = 0;
  const pending = new Map();
  function stop() {
    worker?.terminate(); worker = null;
    for (const { reject } of pending.values()) reject(new Error('Импорт прерван'));
    pending.clear();
  }
  return {
    async parse(file) {
      if (!globalThis.Worker) return parseExcelFile(file);
      if (!worker) {
        try { worker = new Worker(new URL('../parser/importWorker.js', import.meta.url)); }
        catch { return parseExcelFile(file); }
        worker.onmessage = ({ data }) => {
          const request = pending.get(data.id); if (!request) return;
          pending.delete(data.id);
          if (data.initializationFailed) request.reject(Object.assign(new Error(data.error), { fallback: true }));
          else if (data.error) request.reject(new Error(data.error));
          else request.resolve(data.report);
        };
        worker.onerror = () => {
          for (const request of pending.values()) request.reject(Object.assign(new Error('Фоновый импорт недоступен'), { fallback: true }));
          pending.clear(); worker?.terminate(); worker = null;
        };
      }
      const buffer = await file.arrayBuffer(), id = ++counter;
      try {
        return await new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ id, buffer }, [buffer]); });
      } catch (error) {
        if (!error.fallback) throw error;
        stop(); return parseExcelFile(file);
      }
    },
    close: stop,
  };
}
