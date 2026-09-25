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

console.log('\nruntime errors: ' + (runtimeErrors.length ? runtimeErrors.join('; ') : 'none'));
console.log(failures + ' failure(s).');
process.exit(failures || runtimeErrors.length ? 1 : 0);
