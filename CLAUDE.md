# Austruss production checklist apps

Single-file HTML tablet apps for the Austruss production bays. They run on
Samsung tablets in Chrome, installed via Add to Home Screen so they're
full-screen with no address bar. No build step, no framework, no bundler: each
app is one self-contained `.html` file with its CSS and JS inline, edited in
place and served as-is.

| File | Bay | Works from |
|---|---|---|
| `frame-checklist.html` | LGS | FRAMECAD detailer report + production drawings |
| `structural-checklist.html` | Structural steel | Cut length sheets + production drawings |

The structural app is the newer one and is the usual subject of work here. It
was built as a sibling of the LGS app and deliberately shares its design
system, proxy plumbing and gesture code. **Read both files before changing
either.** A fix worth making in one is usually worth porting to the other, but
they are separate files on purpose: don't merge them.

## Hard-won constraints. Do not rediscover these.

These cost real debugging time. Treat them as settled.

- **Smartsheet sends no CORS headers.** The browser can never call
  `api.smartsheet.com` directly. Everything goes through the Cloudflare Worker
  in `smartsheet-proxy-worker.js`, which holds the Smartsheet token as a
  secret. A separate `APP_KEY` guards the Worker, so leaking its URL alone
  doesn't hand out Smartsheet access.
- **Attachment uploads are raw bytes** with exact `Content-Type`,
  `Content-Length` and `Content-Disposition` headers. Not multipart, not JSON,
  not base64. The Worker sets these; don't reshape the body.
- **Attachment downloads go through the Worker's `/download`**, which resolves
  the pre-signed URL and fetches the bytes in the same request. That URL
  expires in 60 seconds and the client must never see it. Don't send an
  Authorization header when fetching a pre-signed URL; it can break it.
- **Re-resolve an attachment's live ID immediately before writing to it.** A
  version bump changes the ID, so one fetched earlier is already stale. See
  `resolveLiveAttachment`.
- **Read cell `value`, not `displayValue`** — except contact-list columns
  (Designer), where `displayValue` is the person's name and `value` is their
  email, and multi-picklists (Types of Items, Finishes), where `displayValue`
  holds the comma-joined text and `value` is null.
- **Match Smartsheet columns by title, never by hardcoded column ID.**
- **Supabase does send proper CORS headers**, so session logging and issue
  notes go direct from the browser. Only Smartsheet needs the Worker.
- **Never use localStorage as the source of truth for anything that matters.**
  It holds connection details, per-job progress and the active session only.
  Real state goes to Smartsheet or Supabase.

## Smartsheet specifics (structural app)

- Report: `Structural - Work Orders (Working)`, ID `4428779186245508`, over the
  Work Order sheet `8417646009601924`. Jobs render in the report's own row
  order. Rows marked Complete are hidden.
- The report carries **no Work Order Type column** because it's already
  filtered to Structural server-side. Don't add a client-side type filter.
- Columns read, by title: Primary, Complete, Project & Zone Number, Designer,
  Scheduled Start Date, Scheduled End Date, Target Delivery Date, Work Record
  URL, Types of Items, Finishes, Total Weight (kg), No. of Structural
  Assemblies, No. of Fabrication Items, No. of Structural Drawings.
- Attachments: everything except names starting with `Cover Page`, `Pack Label`
  or `Mapping`, and the app's own `IN PROGRESS:` uploads. A name matching
  `CUT[\s_-]*LENGTHS?` opens as a cut list; everything else opens as drawings.
  The separator tolerance matters: Smartsheet displays `ZONE A3 - CUT LENGTHS`
  but a downloaded copy arrives as `ZONE_A3_-_CUT_LENGTHS.pdf`.

## Supabase

Project is shared with the LGS app; tables are separate.

| Table | Used by |
|---|---|
| `session_log`, `frame_issues` | LGS app. Leave alone. |
| `ss_session_log`, `ss_issues` | Structural app. DDL in `sql/`. |

RLS restricts the anon (publishable) key to select and insert. The publishable
key is hardcoded in the HTML by design; that's what it's for. The Worker's
`APP_KEY` is **not** in the repo and must never be committed: it's entered on
the tablet's Settings screen and lives in localStorage.

localStorage keys are prefixed `ssc_` in the structural app and `fc_` in the
LGS app, so both can be installed on one tablet without collision. The
structural app falls back to reading `fc_` connection details so the key
doesn't have to be typed twice.

## PDF parsing

Uses pdf.js 3.11.174 (loaded from cdnjs) to read the text layer, and pdf-lib
1.17.1 to write marked-up copies.

- **Always work in viewport coordinates.** `getPageItems` converts every item
  through `page.getViewport().convertToViewportPoint`. The cut length sheets
  are stored with a 90 degree page rotation, so raw `transform[4]/[5]` has x
  and y swapped. Raw coordinates are kept alongside, but only for pdf-lib,
  which works in unrotated PDF space.
- **Cluster rows with a Y tolerance (4pt), never exact equality.** Cells in one
  row of the Excel-exported cut sheet sit 1 to 2pt apart on different
  baselines. Exact matching splits a single row into two.
- **Columns are anchored by header X position**, and each word is assigned to
  the nearest header to its left. That's what survives `5060 mm` arriving as
  two separate text items.
- Drawing identity is a **strategy list, first match wins**. Add to it; don't
  rewrite the existing entries, each is tuned to a real export:
  1. `strategyStructuralTable` — Austruss structural title block, the
     MARK / QTY / LENGTH (mm) / WEIGHT (kg) table, one data row under the header.
  2. `strategyGirder` — FRAMECAD Structure girder trusses,
     `Quantity Required = 2 Mark as GI903`.
  3. `strategyFramecadDetailer` — FRAMECAD Detailer welded LGS panels: the mark
     sits in the title-block column directly above the `DRAWING NAME` label,
     with the office phone number (`02 4860 1400`) as a fallback anchor.
  A page no strategy identifies still works: it's labelled `Page N` with a
  quantity of 1.
- Nothing is keyed off the filename beyond cut list vs drawings, so a file like
  `Combined Structural.pdf` is handled page by page like any other.

## Counting model

Every cut list mark and every drawing page has a quantity and a count, capped
at that quantity. Done means count equals quantity; anything between shows
amber. Cut list marks with quantity 1 are a single tap; above 1 they get a
compact plus/minus so a part-cut mark reads 2/4. Drawing pages use the larger
counter in the panel over the sheet.

Counts are stored per work order row and **per attachment name**, so a new
version of a file keeps its progress.

Save Progress uploads `IN PROGRESS: <original name>.pdf` for every opened file
with at least one count, always as a **new version of the same attachment**,
never a fresh duplicate. Start Job snapshots the counts; the next Save Progress
logs the delta to `ss_session_log` and clears the session. Start Job on its own
writes nothing.

## Known gaps

- A cut sheet that parses to zero rows falls back to one tick per page. Those
  page ticks do **not** roll up into the job-wide totals. Pinned by a test in
  `test/ui.mjs`; if you fix it, that expectation moves from 3 to 4.
- Uploads all show as authored by whoever the Worker's token belongs to, not
  the operator holding the tablet. Matches how the apps were scoped (one shared
  login), but it's a real limitation if upload history ever needs to name a
  person.
- Smartsheet's API caps uploads at 30MB.

## Testing

Run both before and after any change. They take seconds and they have already
caught real bugs.

```bash
npm install                      # pdfjs-dist@3.11.174, pdf-lib@1.17.1, jsdom
node test/parsers.mjs            # real parsers against every PDF in samples/
node test/parsers.mjs cut        # only filenames containing "cut"
node test/parsers.mjs --annotate # also write marked-up PDFs to test/out/
node test/ui.mjs                 # boots the app in jsdom and clicks through it
```

`test/parsers.mjs` pulls the parser functions straight out of the HTML rather
than reimplementing them, so it can't drift from the app. It splits the inline
script at the `APP STATE` banner comment: everything above is DOM-free logic.
**If you rename that banner, update the marker in the harness.**

`test/ui.mjs` runs the app's real inline JS in jsdom with pdf.js and pdf-lib
stubbed, and asserts on wiring the parser tests can't see: element ids,
listeners, rendering, progress arithmetic. It exposes internals via an
`Object.assign(window, {...})` list at the bottom of the file; if you rename an
exported name, update that list too.

**`samples/` is the most valuable thing in this repo.** Every production PDF
that has ever been tested against lives there, including ones that misparse.
Adding a sheet there is how a new layout gets supported without silently
breaking the layouts that already work. Never delete from it.

## Conventions

- One file per app, CSS and JS inline. Don't extract to separate files, don't
  introduce a build step, don't add a framework.
- Comments explain **why**, especially where the code looks odd but is
  deliberate (the pinch anchoring, the Y tolerance, the viewport conversion).
  Keep them when editing nearby code.
- Touch targets are large. `--tap: 56px`, counters are 56 to 64px. This is used
  in a workshop, sometimes with gloves.
- The design system is the Austruss palette already in the `:root` block.
  Orange `#F26B22`, charcoal `#262524`. Don't restyle.
- Commit before any large edit so there's a clean diff to review and revert to.
