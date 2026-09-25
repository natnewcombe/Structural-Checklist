/**
 * test/parsers.mjs — runs the app's REAL parsers against every PDF in samples/
 * ---------------------------------------------------------------------------
 * The point of this harness is that it doesn't reimplement anything. It pulls
 * the parser functions straight out of structural-checklist.html and runs them
 * in Node against the same pdf.js version the tablet loads from the CDN, so a
 * pass here means the tablet will behave the same way.
 *
 *   node test/parsers.mjs                  # every PDF in samples/
 *   node test/parsers.mjs cut              # only files whose name contains "cut"
 *   node test/parsers.mjs --annotate       # also write marked-up copies to test/out/
 *
 * Add every sheet that misparses to samples/ and leave it there permanently.
 * That's what stops a fix for one layout quietly breaking the others.
 */
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const PDFLib = require('pdf-lib');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'structural-checklist.html');
const SAMPLES = path.join(ROOT, 'samples');
const OUT = path.join(ROOT, 'test', 'out');

const args = process.argv.slice(2);
const wantAnnotate = args.includes('--annotate');
const filter = args.filter(a => !a.startsWith('--'))[0] || '';

/* ---------------------------------------------------------------------------
   Extract the parser half of the app's inline JS.
   Everything before the "APP STATE" banner is pure logic with no DOM in it;
   everything after touches document/localStorage and belongs to test/ui.mjs.
   If that banner is ever renamed, this is the one line to update.
   ------------------------------------------------------------------------- */
function loadParsers(){
  const src = fs.readFileSync(APP, 'utf8');
  const firstScript = src.split('<script>')[1];
  if(!firstScript) throw new Error('No inline <script> found in ' + APP);
  const marker = '/* =========================================================================\n   APP STATE';
  const idx = firstScript.indexOf(marker);
  if(idx === -1) throw new Error('APP STATE banner not found: update the marker in test/parsers.mjs');
  let code = firstScript.slice(0, idx);
  // The worker path is a browser-only concern and would 404 here.
  code = code.replace(/pdfjsLib\.GlobalWorkerOptions[\s\S]*?;\n/, '');

  const ctx = {
    pdfjsLib, PDFLib,
    localStorage: { getItem(){ return null; }, setItem(){}, removeItem(){} },
    document: { getElementById(){ return {}; } },
    navigator: {}, fetch
  };
  const fn = new Function(...Object.keys(ctx), code + `
    return { CONFIG, loadPdf, extractCutList, buildDrawingIndex,
             annotateCutListPdf, annotateDrawingsPdf, classifyAttachments, extractTags,
             markupKeywords, parseMarkupKeywords };`);
  return fn(...Object.values(ctx));
}

const api = loadParsers();
const bytes = f => new Uint8Array(fs.readFileSync(f));

/* ------------------------------------------------------------------ report */
let failures = 0;
function fail(msg){ failures++; console.log('  FAIL: ' + msg); }

async function checkCutList(file){
  const pdf = await api.loadPdf(bytes(file));
  const { header, rows } = await api.extractCutList(pdf);
  console.log('  header:', JSON.stringify(header));
  if(!rows.length){
    fail('no rows parsed (the app would fall back to one tick per page)');
    return;
  }
  console.table(rows.map(r => ({
    key: r.key, rev: r.rev, desc: r.desc, material: r.material, size: r.size,
    qty: r.qty, length: r.lengthMm, finish: r.finish, page: r.page
  })));
  const pieces = rows.reduce((a, r) => a + r.qty, 0);
  const metres = rows.reduce((a, r) => a + r.qty * r.lengthMm, 0) / 1000;
  console.log('  ' + rows.length + ' marks, ' + pieces + ' pieces, ' + metres.toFixed(2) + ' linear m');

  rows.forEach(r => {
    if(!r.qty || r.qty < 1) fail(r.key + ': qty missing or zero');
    if(!r.lengthMm) fail(r.key + ': length missing');
    if(!r.desc) fail(r.key + ': description missing');
    if(r.qty > 500) fail(r.key + ': qty ' + r.qty + ' looks like a misread column');
    if(r.lengthMm > 30000) fail(r.key + ': length ' + r.lengthMm + 'mm looks like a misread column');
  });
  const keys = rows.map(r => r.key);
  if(new Set(keys).size !== keys.length) fail('duplicate row keys: counts would collide');

  if(wantAnnotate){
    const counts = {};
    rows.forEach((r, i) => { counts[r.key] = i % 2 ? Math.max(1, r.qty - 1) : r.qty; });
    const out = path.join(OUT, path.basename(file, '.pdf') + '.annotated.pdf');
    fs.writeFileSync(out, await api.annotateCutListPdf(bytes(file), rows, counts));
    console.log('  wrote ' + path.relative(ROOT, out) + ' (odd rows part-counted, even rows complete)');
  }
}

async function checkDrawings(file){
  const pdf = await api.loadPdf(bytes(file));
  const pages = await api.buildDrawingIndex(pdf);
  console.table(pages.map(p => ({
    page: p.page, mark: p.mark, qty: p.qty, length: p.lengthMm,
    kg: p.weightKg, unitKg: p.unitWeightKg, template: p.template,
    note: p.note, tags: (p.tags || []).join(', ')
  })));
  // A page with no text layer (scanned or flattened) can't be identified by
  // any strategy; the app shows it with qty 1 and a hint instead.
  const noText = pages.filter(p => p.noText);
  const unidentified = pages.filter(p => !p.mark && !p.noText);
  console.log('  ' + pages.length + ' pages, ' + (pages.length - unidentified.length - noText.length) + ' identified' +
              (noText.length ? ', ' + noText.length + ' with no text layer (expected: shown as-is, qty 1)' : ''));
  if(unidentified.length){
    fail(unidentified.length + ' page(s) with no mark: ' + unidentified.map(p => p.page).join(', ') +
         ' (they still work, but show as "Page N" instead of the mark)');
  }
  const keys = pages.map(p => p.key);
  if(new Set(keys).size !== keys.length) fail('duplicate page keys: counts would collide');
  pages.forEach(p => { if(!p.qty || p.qty < 1) fail('page ' + p.page + ': qty missing'); });

  if(wantAnnotate){
    const counts = {};
    pages.forEach((p, i) => { counts[p.key] = i % 3 === 0 ? Math.max(1, p.qty - 1) : p.qty; });
    const out = path.join(OUT, path.basename(file, '.pdf') + '.annotated.pdf');
    fs.writeFileSync(out, await api.annotateDrawingsPdf(bytes(file), pages, counts));
    console.log('  wrote ' + path.relative(ROOT, out));
  }
}

/* -------------------------------------------------------------------- main */
if(!fs.existsSync(SAMPLES)){
  console.error('No samples/ folder. Put real production PDFs in ' + path.relative(ROOT, SAMPLES) + ' first.');
  process.exit(1);
}
if(wantAnnotate) fs.mkdirSync(OUT, { recursive: true });

const files = fs.readdirSync(SAMPLES)
  .filter(f => f.toLowerCase().endsWith('.pdf'))
  .filter(f => !filter || f.toLowerCase().includes(filter.toLowerCase()))
  .sort();

if(!files.length){
  console.error('No PDFs in samples/' + (filter ? ' matching "' + filter + '"' : ''));
  process.exit(1);
}

// Route each file exactly the way the app does, by filename, so a file that
// opens as drawings on the tablet is tested as drawings here.
for(const f of files){
  const full = path.join(SAMPLES, f);
  // Files the app hides from the list (e.g. Detailer reports) stay in
  // samples/ but aren't parsed, since no operator ever opens them.
  if(!api.classifyAttachments([{ name: f }]).length){
    console.log('\n=== ' + f + '  [hidden in app, skipped]');
    continue;
  }
  const kind = api.CONFIG.CUTLIST_NAME_RE.test(f) ? 'cutlist' : 'drawings';
  console.log('\n=== ' + f + '  [' + kind + ']');
  try{
    if(kind === 'cutlist') await checkCutList(full);
    else await checkDrawings(full);
  }catch(e){
    fail('threw: ' + e.message);
  }
}

// Save Progress versions the original attachment, and the next open finds its
// way back to the clean drawing through PDF keywords. Check that note survives
// a real pdf-lib write and pdf.js read on a real marked-up sample.
{
  const f = files.find(n => !api.CONFIG.CUTLIST_NAME_RE.test(n) && api.classifyAttachments([{ name: n }]).length);
  console.log('\n=== markup note round-trip  [' + f + ']');
  try{
    const src = bytes(path.join(SAMPLES, f));
    const pages = await api.buildDrawingIndex(await api.loadPdf(src.slice()));
    const marked = await api.annotateDrawingsPdf(src.slice(), pages, { [pages[0].key]: 1 });
    const doc = await PDFLib.PDFDocument.load(marked);
    doc.setKeywords(api.markupKeywords({ sourceId: '123456', skipId: '789' }));
    const meta = await (await api.loadPdf(await doc.save())).getMetadata();
    const note = api.parseMarkupKeywords(meta.info && meta.info.Keywords);
    console.log('  read back: ' + JSON.stringify(note));
    if(!note || note.sourceId !== '123456' || note.skipId !== '789') fail('markup note did not survive pdf-lib -> pdf.js');
    const plain = await (await api.loadPdf(src.slice())).getMetadata();
    if(api.parseMarkupKeywords(plain.info && plain.info.Keywords)) fail('an untouched drawing reads as a markup');
  }catch(e){ fail('markup round-trip threw: ' + e.message); }
}

console.log('\n' + files.length + ' file(s) checked, ' + failures + ' problem(s).');
process.exit(failures ? 1 : 0);
