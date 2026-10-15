# AGENTS.md — FTV Broadcast Analytics & Slot Drop Detector

## 1. Project Overview
Client-side Web SPA for TV ratings analysis, schedule grid visualization, multi-period comparison (Week-over-Week, Day-of-Week e.g. All Thursdays, Seasons, Year-over-Year), and automatic detection of time-slot audience drops (`Lead-in / Lead-out` pain points) for **FTV (UZ/RU)** and competitors.

## 2. Tech Stack & Constraints
- **Runtime:** Pure Client-Side Web App (HTML5, Tailwind CSS via CDN, Vanilla JS ES6 Modules). No backend server required.
- **Libraries (CDN):**
  - `SheetJS (xlsx.full.min.js)` — parsing visible & hidden Excel sheets and `!merges` ranges.
  - `JSZip` — extracting embedded schedule grid scans (`xl/media/image3.png`).
  - `Apache ECharts 5` — interactive timelines (`05:00 - 29:00`), heatmaps, and period comparisons.
  - `IndexedDB` — persistent browser database (`FTV_Analytics_DB`) with deduplication by ISO date.
- **Local Dev Server:** `python3 -m http.server 8080` or `npx serve .`

## 3. Directory Structure
- `index.html` — App shell, CDN imports, layout containers.
- `SPEC.md` — Detailed functional specification and mathematical formulas.
- `src/app.js` — Main entry point, state initialization, event bindings.
- `src/core/db.js` — IndexedDB wrapper (`daily_metrics`, `grid_10min`, `program_logs`, `media_scans`).
- `src/core/state.js` — Reactive store (active mode, audience `18-54` vs `25-34`, date filters, workday toggle).
- `src/parser/excelParser.js` — SheetJS workbook reader, `!merges` unmerger, regex cell parser.
- `src/analytics/comparator.js` — Week, Day-of-Week (All Thursdays), Season, and Year aggregation functions.
- `src/analytics/dropDetector.js` — Lead-in/Lead-out retention calculator and competitor spike attribution.
- `src/ui/charts.js` — Apache ECharts configurations and `ResizeObserver` bindings.
- `src/ui/gridView.js` — 8-tier color-coded 10-minute TV Grid Heatmap and Pain Points cards.

## 4. Critical Data Rules (FTV Excel Format)
1. **Never parse report dates from filenames** (filenames may contain typos like `11.11.26` for `11.10.2026`). Always extract the report date from sheet `СОДЕРЖАНИЕ` cell `F1` or `Сетка_FTV_каналы` cell `C2`.
2. **Broadcast Day (`05:00 - 29:00`):** Convert `HH:MM:SS` (including `24:xx` to `28:xx`) to total seconds (`hours * 3600 + min * 60 + sec`) so night slots stay anchored to the same broadcast date.
3. **Unmerging Schedule Grids (`Сетка_FTV_каналы` & `Сетка_FTV_неделя`):**
   - Rows `6` to `149` represent 144 ten-minute slots (`05:00 - 05:10` .. `28:50 - 29:00`).
   - Program cells are vertically merged (`sheet['!merges']`). Always propagate the top-left cell value (`s.r, s.c`) across all rows `s.r .. e.r` before parsing rows.
   - Cell format regex: `^(?<title>.+?)\s*\/\s*(?:N\/A\s*\/\s*)?Share=(?<share>[\d.,]+)\s*\/\s*Rtg%=(?<rtg>[\d.,]+)$`
4. **Hidden Sheets are Primary Data Sources:**
   - `FTV_60 дней` (hidden): Rows `5..64` provide 60 days of daily history (`Share`, `Rtg%`, `AvRch%`, `AvAud` for `18-54` in cols `C:F`, `25-34` in cols `G:J`, and workday flag in col `AG`).
   - `TOP_FTV` & `TOP_каналы` (hidden): Rows `4..end` provide exact `Start time` and `End time` down to the second (`A:G`) across FTV and 68 competitors.
   - `Аудитория` (hidden): Rows `4..18` provide gender/age (`M/W 18-54` breakdown) for every FTV program by `Start time`.

## 5. Coding Standards
- Keep modules strictly decoupled: `parser/` never touches DOM; `analytics/` contains pure functions only; `ui/` renders state and ECharts.
- Normalize all decimal commas to dots before `parseFloat()`.
## 6. Publication workflow
- Iterate and publish working versions in the existing Sites project.
- Do not commit or push iterations to the project GitHub repository unless the user explicitly requests publishing that version to GitHub. Sites source synchronization is part of hosting and remains allowed.

## 7. UI direction
- The main module is the original long Excel viewing chart, cropped to the same selected clock interval and shown side by side across dates.
- Keep four clear modules: viewing trend, programmes, period comparisons, data/import.
- No permanent sidebars or custom chart builder in the current version. Controls for dates, weekday buttons, time, channel and optional programme belong above the chart.
- Never substitute programme averages for the original minute curve. Unavailable scans are explicit, and image time calibration must be verified.
