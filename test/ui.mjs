/**
 * test/ui.mjs — boots structural-checklist.html in jsdom and clicks through it
 * ---------------------------------------------------------------------------
 * Catches the failures that a parser test can't: a renamed element id, a
 * listener wired to the wrong button, a screen that renders nothing, progress
 * that doesn't add up. It runs the app's real inline JS, so it breaks when the
 * app breaks.
 *
 *   node test/ui.mjs
 *
 * pdf.js and pdf-lib are stubbed rather than loaded: this harness is about the
 * UI's wiring, and test/parsers.mjs already runs the real thing against real
 * PDFs. Neither Smartsheet nor Supabase is contacted; fetch is stubbed too.
 */
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'structural-checklist.html');

let failures = 0;
function check(label, actual, expected){
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if(!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + label +
    (ok ? '  (' + JSON.stringify(actual) + ')'
        : '\n         expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)));
}

/* ------------------------------------------------------------------- setup */
const src = fs.readFileSync(APP, 'utf8');
// jsdom has no network; the CDN tags are replaced by the stubs below.
const html = src.replace(/<script src="https:[^"]*"><\/script>/g, '');
// A real origin, otherwise localStorage throws for an opaque origin.
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://local.test/' });
const w = dom.window;
const d = w.document;

function fakePdf(pages){
  return { numPages: pages, getPage: async () => ({
    rotate: 0,
    getViewport: () => ({ width: 800, height: 600, convertToViewportPoint: (x, y) => [x, y] }),
    getTextContent: async () => ({ items: [] }),
    render: () => ({ promise: Promise.resolve() })
  })};
}
w.pdfjsLib = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve(fakePdf(2)) }) };
w.PDFLib = {};
w.HTMLCanvasElement.prototype.getContext = () => ({});
w.fetch = async () => ({ ok: true, json: async () => ({ columns: [], rows: [] }), text: async () => '' });

const runtimeErrors = [];
w.addEventListener('error', e => runtimeErrors.push(e.message));

// Expose the app's internals so the harness can drive them directly. Keep this
// list in step with the app: a name that disappears here is a rename to notice.
const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]).join('\n');
const expose = '\n;Object.assign(window,{Store,AppState,CV,DV,renderJobList,renderCutList,' +
               'fileCounts,fileProgress,jobProgress,showScreen,setTabbarVisible,jobMatches,classifyAttachments});';
try{
  w.eval(code + expose);
}catch(e){
  console.log('BOOT ERROR: ' + e.message);
  process.exit(1);
}
await new Promise(r => setTimeout(r, 200));
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

/* ------------------------------------------------------------------- boot */
console.log('\nboot');
check('setup screen shown when unconfigured', d.getElementById('screen-setup').classList.contains('active'), true);

/* --------------------------------------------------------------- job list */
console.log('\njob list + search');
w.eval(`
  Store.setWorkerUrl('https://x.workers.dev'); Store.setAppKey('k');
  AppState.jobs = [
    {rowId:1, sheetId:2, workOrderId:'W-14116', zone:'UNIT 9', complete:'Not Started',
     itemTypes:'Girder Trusses', finishes:'Galvanised', designer:'N.N'},
    {rowId:3, sheetId:2, workOrderId:'W-14132', zone:'ZONE A3', complete:'Partially Complete',
     itemTypes:'Columns', finishes:'REC-Painted', totalWeightKg: 820}
  ];
  setTabbarVisible(true); showScreen('screen-jobs'); renderJobList();
`);
check('both jobs render', d.querySelectorAll('.job-card').length, 2);
check('weight chip shown', !!d.querySelector('.meta-chip.weight'), true);
w.eval("AppState.jobSearchTerm='a3 columns'; renderJobList();");
check('multi-word search across fields', d.querySelectorAll('.job-card').length, 1);
w.eval("AppState.jobSearchTerm='galv'; renderJobList();");
check('search matches finishes', d.querySelectorAll('.job-card').length, 1);
w.eval("AppState.jobSearchTerm='zzz'; renderJobList();");
check('no match shows empty state', !!d.querySelector('#jobListContainer .empty'), true);
w.eval("AppState.jobSearchTerm=''; renderJobList();");

/* ------------------------------------------------------- attachment filter */
console.log('\nattachment filter');
const kinds = w.eval(`JSON.stringify(classifyAttachments([
  {name:'Cover Page_W-14132_x.pdf'}, {name:'Pack Label_W-14132.pdf'},
  {name:'Mapping for Work Order Weld Label.pdf'}, {name:'IN PROGRESS: x.pdf'},
  {name:'25363 ZONE A3 - CUT LENGTHS.pdf'}, {name:'25363_ZONE_A3_-_CUT_LENGTHS.pdf'},
  {name:'Combined Structural.pdf'}, {name:'notes.dxf'},
  {name:'25415-LGS-1-600 [A] BUILDING 1 - Detailer - Report - Girders.pdf'},
  {name:'22095-LGS-B1-040 (A) Unit 181 - Job Info File - Structural.pdf'}
]).map(a => a.name + '=' + a.kind))`);
check('excludes generated files and detailer reports, routes by name', JSON.parse(kinds), [
  '25363 ZONE A3 - CUT LENGTHS.pdf=cutlist',
  '25363_ZONE_A3_-_CUT_LENGTHS.pdf=cutlist',
  'Combined Structural.pdf=drawings',
  '22095-LGS-B1-040 (A) Unit 181 - Job Info File - Structural.pdf=cutlist'
]);

/* ---------------------------------------------------------- cut list screen */
console.log('\ncut list: ticks and counters');
w.eval(`
  AppState.currentJob = AppState.jobs[1];
  AppState.files = [{id:9, name:'CUT LENGTHS.pdf', kind:'cutlist'}];
  AppState.current = {name:'CUT LENGTHS.pdf', kind:'cutlist'};
  AppState.fileParsed['CUT LENGTHS.pdf'] = { kind:'cutlist', header:{}, rows:[
    {key:'C1000',mark:'C1000',label:'C1000',rev:'1',desc:'RHS_150x50x2',material:'RHS',
     size:'150x50x2.0',qty:4,lengthMm:5060,finish:'REC-Painted',comment:'',page:1},
    {key:'B1002',mark:'B1002',label:'B1002',rev:'1',desc:'RHS_150x100x4',material:'RHS',
     size:'150x50x2.0',qty:1,lengthMm:3424,finish:'REC-Painted',comment:'',page:1}
  ]};
  CV.setPdf({numPages:1}); CV.count = 1; CV.page = 1;
  showScreen('screen-cutlist'); renderCutList();
`);
check('a row per mark', d.querySelectorAll('#frameList .frame-row').length, 2);
check('every row has a tick box', d.querySelectorAll('#frameList .tickbox').length, 2);
check('counter only on the multi-piece mark', d.querySelectorAll('#frameList .counter').length, 1);

click(d.querySelectorAll('#frameList .frame-row')[1]);      // qty 1 -> ticks
check('tapping a qty-1 row completes it', w.eval("JSON.stringify(fileCounts('CUT LENGTHS.pdf'))"), '{"B1002":1}');
click(d.querySelector('#frameList .counter .plus'));
check('plus increments the multi-piece mark', w.eval("JSON.stringify(fileCounts('CUT LENGTHS.pdf'))"), '{"B1002":1,"C1000":1}');
check('partial row styled amber', d.querySelectorAll('#frameList .frame-row.partial').length, 1);
check('summary counts marks and pieces',
  [d.getElementById('doneCount').textContent, d.getElementById('totalCount').textContent,
   d.getElementById('pieceDoneCount').textContent, d.getElementById('pieceTotalCount').textContent],
  ['1', '2', '2', '5']);
click(d.querySelector('#frameList .counter .minus'));
check('minus decrements', w.eval("JSON.stringify(fileCounts('CUT LENGTHS.pdf'))"), '{"B1002":1}');

/* --------------------------------------------- cut list: unparseable sheet */
console.log('\ncut list: fallback when nothing parses');
w.eval(`
  AppState.files.push({id:10, name:'BAD CUT LENGTHS.pdf', kind:'cutlist'});
  AppState.current = {name:'BAD CUT LENGTHS.pdf', kind:'cutlist'};
  AppState.fileParsed['BAD CUT LENGTHS.pdf'] = { kind:'cutlist', header:{}, rows:[] };
  CV.count = 3; CV.page = 1; renderCutList();
`);
check('explains itself instead of going blank', !!d.querySelector('.cut-hint'), true);
check('one tick per page', d.querySelectorAll('#frameList .frame-row').length, 3);
click(d.querySelectorAll('#frameList .frame-row')[0]);   // page 1 is on screen -> ticks
check('ticking the visible page', w.eval("JSON.stringify(fileCounts('BAD CUT LENGTHS.pdf'))"), '{"PAGE 1":1}');
click(d.querySelectorAll('#frameList .frame-row')[2]);   // page 3 is not -> jumps first
check('a row for an off-screen page jumps there first', [w.eval('CV.page'), w.eval("JSON.stringify(fileCounts('BAD CUT LENGTHS.pdf'))")], [3, '{"PAGE 1":1}']);

/* --------------------------------------------------------- drawings screen */
console.log('\ndrawings: counter panel');
w.eval(`
  AppState.files.push({id:11, name:'STRUCTURAL PRODUCTION.pdf', kind:'drawings'});
  AppState.current = {name:'STRUCTURAL PRODUCTION.pdf', kind:'drawings'};
  AppState.drawingPages = [
    {page:1, key:'C1006', mark:'C1006', label:'C1006', qty:2, lengthMm:4425, weightKg:37, unitWeightKg:37, tags:['CHK DRAWING'], note:''},
    {page:2, key:'C1005', mark:'C1005', label:'C1005', qty:2, lengthMm:4425, weightKg:74, unitWeightKg:37, tags:[], note:''}
  ];
  AppState.fileParsed['STRUCTURAL PRODUCTION.pdf'] = { kind:'drawings', pages: AppState.drawingPages };
  DV.setPdf({numPages:2}); DV.count = 2; DV.page = 1;
  showScreen('screen-drawings'); updatePageTagRow(); updateCounterPanel();
`);
check('panel shows the page mark', d.getElementById('cpMark').textContent, 'C1006');
check('panel shows quantity', d.getElementById('cpQty').textContent, '2');
check('tag chip rendered', d.querySelectorAll('#pageTagRow .tag-chip').length, 1);
click(d.getElementById('cpPlus'));
check('plus counts one off', [d.getElementById('cpCount').textContent, d.getElementById('cpState').textContent], ['1', 'In progress']);
click(d.getElementById('cpPlus'));
check('reaching quantity completes the page', [d.getElementById('cpCount').textContent, d.getElementById('cpState').textContent], ['2', 'Complete']);
check('plus disabled at the cap', d.getElementById('cpPlus').disabled, true);

/* ---------------------------------------------------------- job-wide totals */
console.log('\nprogress rollup');
// Known gap, deliberately pinned: a sheet that parsed to zero rows falls back
// to one tick per page, and those ticks do NOT roll up into the job totals
// (the file has no parsed items to total against). B1002 + C1006 x2 = 3, not
// the 4 you'd get if the fallback tick on BAD CUT LENGTHS.pdf counted. If that
// is ever fixed, this expectation moves to 4.
check('job progress across both files',
  w.eval("(function(){var p=jobProgress();return [p.items,p.itemsDone,p.pieces,p.piecesDone];})()"),
  [4, 2, 9, 3]);

/* ------------------------------------------------ versions: which to count */
console.log('\nversions: which drawing to count against');
const APP_EMAIL = 'app@austruss.com.au', DES = 'designer@austruss.com.au';
const V = (id, day, who) => ({ id, createdAt: '2026-09-' + day + 'T00:00:00Z', createdBy: { email: who, name: who } });
const pick = (versions, note) => JSON.parse(w.eval('JSON.stringify((function(){' +
  'var p = pickWorkingVersion(' + JSON.stringify(versions) + ',' + JSON.stringify(APP_EMAIL) + ',' + JSON.stringify(note) + ');' +
  'return { base: p.base && p.base.id, newer: p.newer && p.newer.id, revised: p.revisedSinceSave }; })())'));
check('never saved: counts on the latest drawing',
  pick([V(1,'01',DES), V(2,'02',DES)], null), { base: 2, newer: null, revised: false });
check('after a save: back to the clean drawing, not the markup',
  pick([V(1,'01',DES), V(2,'02',APP_EMAIL)], { sourceId: '1' }), { base: 1, newer: null, revised: false });
check('designer revision after a save is offered and badged',
  pick([V(1,'01',DES), V(2,'02',APP_EMAIL), V(3,'03',DES)], { sourceId: '1' }), { base: 1, newer: 3, revised: true });
check('a declined revision is not offered again',
  pick([V(1,'01',DES), V(2,'02',APP_EMAIL), V(3,'03',DES), V(4,'04',APP_EMAIL)], { sourceId: '1', skipId: '3' }), { base: 1, newer: null, revised: false });
check('a revision switched to becomes the base',
  pick([V(1,'01',DES), V(2,'02',APP_EMAIL), V(3,'03',DES), V(4,'04',APP_EMAIL)], { sourceId: '3' }), { base: 3, newer: null, revised: false });
check('markup note unreadable: newest clean version before the last save',
  pick([V(1,'01',DES), V(2,'02',APP_EMAIL)], null), { base: 1, newer: null, revised: false });
check('markup keywords round-trip',
  w.eval("JSON.stringify(parseMarkupKeywords(markupKeywords({sourceId:'1',skipId:'3'}).join(' ')))"), '{"sourceId":"1","skipId":"3"}');
check('an ordinary PDF has no markup note', w.eval("parseMarkupKeywords('')"), null);

/* ------------------------------------------ versions: open and save wiring */
console.log('\nversions: open and save');
const calls = [];
function route(url, opts){
  url = String(url);
  calls.push({ url, method: (opts && opts.method) || 'GET' });
  const json = body => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });
  if(url.includes('/api/users/me')) return json({ email: APP_EMAIL });
  if(url.includes('/versions')) return json({ data: [V(70,'01',DES), V(77,'02',APP_EMAIL)] });
  if(url.includes('/rows/') && url.includes('/attachments')) return json({ data: [
    { id: 77, name: 'CUT LENGTHS.pdf', attachmentType: 'FILE', createdAt: '2026-09-02T00:00:00Z' }] });
  if(url.includes('/download')) return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  return json({});
}
w.fetch = async (url, opts) => route(url, opts);
// The newest app save says it was drawn from version 70.
w.pdfjsLib.getDocument = () => ({ promise: Promise.resolve(Object.assign(fakePdf(1), {
  getMetadata: async () => ({ info: { Keywords: 'austruss-ssc-markup ssc-source:70' } })
})) });
await w.eval("loadWorkingBytes({ id: 77, name: 'CUT LENGTHS.pdf', kind: 'cutlist' })");
const downloads = calls.filter(c => c.url.includes('/download')).map(c => new URL(c.url).searchParams.get('attachmentId'));
check('opening reads the markup, then downloads the clean version it names', downloads, ['77', '70']);
check('remembers which clean version the file is counted on',
  w.eval("JSON.stringify(AppState.fileSource['CUT LENGTHS.pdf'])"), '{"sourceId":70,"skipId":null}');

// Safety net: no version history (or no createdBy), and the latest version is
// one of our markups. Its note still leads back to the clean drawing.
calls.length = 0;
w.fetch = async (url, opts) => { if(String(url).includes('/versions')) throw new Error('offline'); return route(url, opts); };
w.eval("AppState.fileSource = {}");
await w.eval("loadWorkingBytes({ id: 77, name: 'CUT LENGTHS.pdf', kind: 'cutlist' })");
check('without version history, a markup still leads back to its clean source',
  calls.filter(c => c.url.includes('/download')).map(c => new URL(c.url).searchParams.get('attachmentId')), ['77', '70']);
w.fetch = async (url, opts) => route(url, opts);
w.eval("AppState.fileSource['CUT LENGTHS.pdf'] = { sourceId: 70, skipId: null }");

calls.length = 0;
w.eval(`
  annotateCutListPdf = async () => new Uint8Array([1]);
  annotateDrawingsPdf = async () => new Uint8Array([1]);
  PDFLib.PDFDocument = { load: async () => ({ setKeywords(k){ window.__keywords = k; }, save: async () => new Uint8Array([2]) }) };
  AppState.fileBytes = { 'CUT LENGTHS.pdf': new ArrayBuffer(8) };
`);
await w.eval("saveProgress(document.createElement('button'))");
const uploads = calls.filter(c => c.url.includes('/upload'));
const up = uploads[0] ? new URL(uploads[0].url).searchParams : new URLSearchParams();
check('one upload, for the file that has counts and bytes', uploads.length, 1);
check('uploaded as a new version of the original, same name',
  [up.get('mode'), up.get('attachmentId'), up.get('filename')], ['version', '77', 'CUT LENGTHS.pdf']);
check('no IN PROGRESS copy is created', calls.some(c => decodeURIComponent(c.url).includes('IN PROGRESS')), false);
check('markup is keyworded with its clean source', w.eval('JSON.stringify(window.__keywords)'), '["austruss-ssc-markup","ssc-source:70"]');

console.log('\nruntime errors: ' + (runtimeErrors.length ? runtimeErrors.join('; ') : 'none'));
console.log(failures + ' failure(s).');
process.exit(failures || runtimeErrors.length ? 1 : 0);
