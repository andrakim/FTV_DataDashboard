// A classic worker keeps ZIP extraction and workbook parsing off the UI thread.
let parser;
self.onmessage = async ({ data: { id, buffer } }) => {
  try {
    if (!parser) {
      importScripts('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
      parser = await import('./excelParser.js');
    }
    const report = await parser.parseExcelFile(buffer, { XLSX: self.XLSX, JSZip: self.JSZip });
    self.postMessage({ id, report });
  } catch (error) { self.postMessage({ id, error: error.message, initializationFailed: !parser }); }
};
