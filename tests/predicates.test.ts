/**
 * tests/predicates.test.ts — run with plain `node --test`. No jest, no vitest.
 *
 * Every assertion names the recall_number it exercises and reads that notice out
 * of the frozen snapshot in data/recalls.json, so the tests fail if the parser
 * regresses OR if the snapshot is replaced with something that does not say what
 * the tests claim it says.
 *
 * The adversarial cases are the point: a unit one step inside a range, one step
 * outside it, a date that is ambiguous in the source, a code list that the
 * source truncated, and a code list the source redacted. The corpus-wide
 * invariants at the end are the safety net — they assert over all 13,480
 * notices that the engine never invents a clear.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Notice } from '../data/fetch.ts';
import { evaluate, parseCodeInfo, codeTokens, atomicTokens, findDates, anyOf } from '../src/predicates.ts';
import type { UnitCodes, Verdict } from '../src/predicates.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOTICES: Notice[] = JSON.parse(readFileSync(join(ROOT, 'data', 'recalls.json'), 'utf8'));

const byRecall = new Map<string, Notice>();
for (const n of NOTICES) if (!byRecall.has(n.recall_number)) byRecall.set(n.recall_number, n);

function notice(recallNumber: string): Notice {
  const n = byRecall.get(recallNumber);
  assert.ok(n, `frozen snapshot has no recall_number ${recallNumber}`);
  return n;
}

/** Assert a verdict and, on failure, print the clause trace that produced it. */
function verdict(recallNumber: string, unit: UnitCodes, want: Verdict, note = ''): void {
  const a = evaluate(notice(recallNumber), unit);
  const trace = a.clauses
    .map((c) => `      [${c.result}] ${c.key} given=${c.given ?? '-'} :: ${c.evidence.replace(/\s+/g, ' ').slice(0, 90)}`)
    .join('\n');
  assert.equal(
    a.verdict,
    want,
    `${recallNumber} ${JSON.stringify(unit)} => ${a.verdict}, wanted ${want}${note ? ` (${note})` : ''}\n${trace}`,
  );
}

const clausesOf = (recallNumber: string) => {
  const n = notice(recallNumber);
  return parseCodeInfo(n.code_info, {
    contextYear: Number(n.report_date.slice(0, 4)),
    truncated: Boolean(n.code_info_truncated),
  }).clauses;
};

// ---------------------------------------------------------------------------
// H-1230-2026 — Kroger / Midwest Poultry eggs. Class I, Ongoing. One notice that
// ANDs a plant code, a Julian day range and a best-by window. This is the case a
// search box cannot answer.
//   "Codes P-1950 or 0840962 with a Julian Date between 157 and 184 and a
//    Best By/Sell By date Between July 20 - August 17, 2026"
// ---------------------------------------------------------------------------

test('H-1230-2026: same carton, Julian 173 inside the range is AFFECTED', () => {
  verdict('H-1230-2026', { lot: 'P-1950', julian: '173', best_by: '2026-08-01' }, 'AFFECTED');
});

test('H-1230-2026: same carton, Julian 200 outside the range is NOT_AFFECTED', () => {
  verdict('H-1230-2026', { lot: 'P-1950', julian: '200', best_by: '2026-09-01' }, 'NOT_AFFECTED');
});

test('H-1230-2026: Julian range is inclusive at both ends (157 and 184)', () => {
  const julian = clausesOf('H-1230-2026').find((c) => c.key === 'julian');
  assert.ok(julian, 'expected a Julian clause');
  assert.equal(julian.test('156'), 'NO', 'one day before the range');
  assert.equal(julian.test('157'), 'YES', 'first day of the range');
  assert.equal(julian.test('184'), 'YES', 'last day of the range');
  assert.equal(julian.test('185'), 'NO', 'one day after the range');
});

test('H-1230-2026: without the Julian code the answer is NEED_CODE, not a clear', () => {
  const a = evaluate(notice('H-1230-2026'), { lot: 'P-1950' });
  assert.equal(a.verdict, 'NEED_CODE');
  assert.ok(a.missingKeys.includes('julian'));
  assert.match(a.questions.join(' '), /Julian/i);
  // The notice says where the code is printed; the question repeats it.
  assert.match(a.questions.join(' '), /left or right sides of the carton/i);
});

test('H-1230-2026: every verdict carries the verbatim code_info it reasoned over', () => {
  const a = evaluate(notice('H-1230-2026'), { lot: 'P-1950', julian: '173', best_by: '2026-08-01' });
  for (const c of a.clauses) {
    assert.ok(c.evidence.length > 0, `clause ${c.key} has no evidence`);
    assert.ok(
      notice('H-1230-2026').code_info.includes(c.evidence),
      `clause ${c.key} evidence is not a verbatim slice of code_info`,
    );
  }
});

// ---------------------------------------------------------------------------
// Set membership over an unlabelled list — H-1228-2026:
//   "B15354, B15356, B15357, B15360, B15361, B15363"
// ---------------------------------------------------------------------------

test('H-1228-2026: an unlabelled lot list still discriminates units', () => {
  verdict('H-1228-2026', { lot: 'B15357' }, 'AFFECTED');
  verdict('H-1228-2026', { lot: 'B15999' }, 'NOT_AFFECTED');
});

// ---------------------------------------------------------------------------
// Ranges over codes — H-0309-2026:
//   "lot codes starting with SO-69006 and ending with SO-72558"
// ---------------------------------------------------------------------------

test('H-0309-2026: lot range is inclusive at both endpoints', () => {
  verdict('H-0309-2026', { lot: 'SO-69006' }, 'AFFECTED', 'lower endpoint');
  verdict('H-0309-2026', { lot: 'SO-72558' }, 'AFFECTED', 'upper endpoint');
});

test('H-0309-2026: one step past either endpoint is NOT_AFFECTED', () => {
  verdict('H-0309-2026', { lot: 'SO-69005' }, 'NOT_AFFECTED', 'one below');
  verdict('H-0309-2026', { lot: 'SO-72559' }, 'NOT_AFFECTED', 'one above');
});

test('H-0287-2025: "Lot # 24351 through lot # 25156" survives the repeated label', () => {
  verdict('H-0287-2025', { lot: '24351' }, 'AFFECTED');
  verdict('H-0287-2025', { lot: '25156' }, 'AFFECTED');
  verdict('H-0287-2025', { lot: '25157' }, 'NOT_AFFECTED');
});

// ---------------------------------------------------------------------------
// Open-ended cutoffs
// ---------------------------------------------------------------------------

test('H-1152-2026: "up to and including March 15, 2028" is inclusive', () => {
  verdict('H-1152-2026', { best_by: '2028-03-15' }, 'AFFECTED');
  verdict('H-1152-2026', { best_by: '2028-03-16' }, 'NOT_AFFECTED');
});

test('H-1071-2026: "Packed On date of May 05. 26 or before" reads 26 as the year', () => {
  verdict('H-1071-2026', { mfg_date: '2026-05-05' }, 'AFFECTED');
  verdict('H-1071-2026', { mfg_date: '2026-05-06' }, 'NOT_AFFECTED');
  verdict('H-1071-2026', { mfg_date: '2026-01-02' }, 'AFFECTED', 'well before the cutoff');
});

test('H-0685-2026: "All Lot Codes including and prior to 01APR2027" is a cutoff, not a universal', () => {
  const c = clausesOf('H-0685-2026').find((x) => x.key === 'lot');
  assert.ok(c);
  assert.equal(c.form, 'cutoff', 'must not be parsed as UNIVERSAL_ALL');
  assert.equal(c.test('01MAR2027'), 'YES');
  assert.equal(c.test('01MAY2027'), 'NO');
});

test('Z-2938-2026: "All serial numbers up to 11608268" bounds the serial', () => {
  const unit = { udi: '04050147013797', software: '1.0.3' };
  verdict('Z-2938-2026', { ...unit, serial: '11608268' }, 'AFFECTED', 'the bound itself');
  verdict('Z-2938-2026', { ...unit, serial: '11608269' }, 'NOT_AFFECTED', 'one past the bound');
});

// ---------------------------------------------------------------------------
// Julian encodings — the field order is inferred, never assumed
// ---------------------------------------------------------------------------

test('H-0180-2026: "julian date format (YYDDD) 25254" is an exact YYDDD match', () => {
  verdict('H-0180-2026', { julian: '25254', best_by: '2026-03-10' }, 'AFFECTED');
  verdict('H-0180-2026', { julian: '25255', best_by: '2026-03-11' }, 'NOT_AFFECTED');
});

test('"Julian Dates 3355 to 1536" decodes as DDDY, not YDDD — a numeric compare inverts it', () => {
  const n = NOTICES.find((x) => x.code_info.startsWith('Julian Dates 3355 to 1536'));
  assert.ok(n, 'frozen snapshot has lost the DDDY notice');
  const c = parseCodeInfo(n.code_info, { contextYear: 2026 }).clauses.find((x) => x.key === 'julian');
  assert.ok(c);
  // 3355 = day 335 of 2025 (01 Dec 2025); 1536 = day 153 of 2026 (02 Jun 2026),
  // which is exactly the parenthetical the notice supplies for itself.
  assert.equal(c.test('3355'), 'YES', 'the lower endpoint');
  assert.equal(c.test('0016'), 'YES', 'day 1 of 2026, inside the window');
  assert.equal(c.test('2005'), 'NO', 'day 200 of 2025, before the window');
});

// ---------------------------------------------------------------------------
// Ambiguity must never resolve into a clear
// ---------------------------------------------------------------------------

test('H-1225-2026: "EXP: 06/08/28" is ambiguous, so both readings are affected', () => {
  verdict('H-1225-2026', { lot: '60609-8', expiry: '06/08/28' }, 'AFFECTED', 'month-first reading');
  verdict('H-1225-2026', { lot: '60609-8', expiry: '08/06/28' }, 'AFFECTED', 'day-first reading');
  verdict('H-1225-2026', { lot: '60609-8', expiry: '01/01/2029' }, 'NOT_AFFECTED', 'neither reading');
});

test('H-0582-2025: the notice annotates its own order as (DD/MM/YYYY) and that wins', () => {
  const c = clausesOf('H-0582-2025').find((x) => x.key === 'best_by');
  assert.ok(c);
  assert.equal(c.test('13/01/2026'), 'YES', '13 January 2026');
  assert.equal(c.test('2026-01-13'), 'YES', 'same date written unambiguously');
  assert.equal(c.test('2026-01-12'), 'NO');
});

// ---------------------------------------------------------------------------
// Undecidable sources — redacted and truncated. These MUST NOT clear.
// ---------------------------------------------------------------------------

test('Z-2182-2025: source-redacted lots ("2007xxxxx to 2012xxxxx") never clear a unit', () => {
  verdict('Z-2182-2025', { lot: '200712345' }, 'NEED_CODE', 'looks in range');
  verdict('Z-2182-2025', { lot: '999999999' }, 'NEED_CODE', 'looks out of range');
  assert.equal(evaluate(notice('Z-2182-2025'), { lot: '999999999' }).sourceIncomplete, true);
});

test('Z-2179-2026: "Lot Numbers: xxxxx" is undecidable and never returns NOT_AFFECTED', () => {
  for (const lot of ['12345', 'ABCDE', '']) {
    const a = evaluate(notice('Z-2179-2026'), { lot, udi: '00885825003876' });
    assert.notEqual(a.verdict, 'NOT_AFFECTED', `lot ${JSON.stringify(lot)} produced a clear`);
  }
});

test('a snapshot-truncated notice degrades to NEED_CODE, never to a false clear', () => {
  const t = NOTICES.find((n) => n.code_info_truncated);
  assert.ok(t, 'frozen snapshot has no truncated notices');
  const a = evaluate(t, { lot: 'NOTHING-LIKE-THIS-9999', serial: 'ZZZ999', model: 'ZZZ999' });
  assert.equal(a.sourceIncomplete, true);
  assert.notEqual(a.verdict, 'NOT_AFFECTED', `${t.recall_number} cleared a unit from truncated text`);
});

test('H-0073-2026: masked military-time codes cannot clear, and a real code still flags', () => {
  verdict('H-0073-2026', { lot: 'CT127' }, 'AFFECTED');
  assert.notEqual(evaluate(notice('H-0073-2026'), { lot: 'ZZ999' }).verdict, 'NOT_AFFECTED');
});

// ---------------------------------------------------------------------------
// Whole-product notices — no code discriminates, so every unit is in scope
// ---------------------------------------------------------------------------

test('H-0173-2026: "No codes applied" means every unit is affected', () => {
  const a = evaluate(notice('H-0173-2026'), {});
  assert.equal(a.verdict, 'AFFECTED');
  assert.equal(a.wholeProduct, true);
});

test('H-0780-2026: "No lot numbers provided. Recall includes all product." is constant-true', () => {
  verdict('H-0780-2026', {}, 'AFFECTED');
});

test('CPSC 21198: prose with no code ("all Boppy Newborn Loungers") is not mistaken for a code list', () => {
  const a = evaluate(notice('21198'), {});
  assert.equal(a.verdict, 'AFFECTED');
  assert.equal(a.clauses.length, 0, 'prose must not produce phantom code clauses');
});

// ---------------------------------------------------------------------------
// CPSC — qualifiers live in Description prose and parse identically
// ---------------------------------------------------------------------------

test('CPSC 26733: "manufactured before December 15, 2025" bounds the bed rails', () => {
  verdict('26733', { model: 'FBL140202', mfg_date: '2025-12-14' }, 'AFFECTED');
  verdict('26733', { model: 'FBL140202', mfg_date: '2026-01-05' }, 'NOT_AFFECTED');
});

test('CPSC 26096: "date codes, in YYYYMM format, from 202409 to 202501"', () => {
  verdict('26096', { model: 'LP01711', date_code: '202409' }, 'AFFECTED', 'lower endpoint');
  verdict('26096', { model: 'LP01711', date_code: '202501' }, 'AFFECTED', 'upper endpoint');
  verdict('26096', { model: 'LP01711', date_code: '202502' }, 'NOT_AFFECTED', 'one month past');
});

test('CPSC 19059: "2017-37-FY through 2018-22-FY" orders a mixed alphanumeric date code', () => {
  const c = clausesOf('19059').find((x) => x.key === 'date_code');
  assert.ok(c);
  assert.equal(c.test('2017-37-FY'), 'YES', 'lower endpoint');
  assert.equal(c.test('2018-01-FY'), 'YES', 'inside');
  assert.equal(c.test('2018-22-FY'), 'YES', 'upper endpoint');
  assert.equal(c.test('2018-23-FY'), 'NO', 'one week past');
  assert.equal(c.test('2016-40-FY'), 'NO', 'before the range');
});

test('CPSC 19059: the "X means already inspected" exclusion is surfaced, never auto-applied', () => {
  const a = evaluate(notice('19059'), { date_code: '2018-01-FY', upc: '885911037518' });
  assert.match(a.caveats.join(' '), /inspected/i);
  assert.notEqual(a.verdict, 'NOT_AFFECTED', 'an exclusion clause must not clear a unit by itself');
});

test('CPSC 23022: prefix "A4" plus "a five-digit number less than 22249"', () => {
  const c = clausesOf('23022').find((x) => x.key === 'date_code');
  assert.ok(c);
  assert.equal(c.test('A422100'), 'YES', 'right prefix, tail below the bound');
  assert.equal(c.test('A422500'), 'NO', 'right prefix, tail above the bound');
  assert.equal(c.test('B422100'), 'NO', 'wrong prefix');
});

// ---------------------------------------------------------------------------
// Conjunction and disjunction
// ---------------------------------------------------------------------------

test('H-1138-2026: two lot/date pairs are alternatives, not a conjunction', () => {
  verdict('H-1138-2026', { lot: '26J000059877-01', mfg_date: '2026-04-27' }, 'AFFECTED');
  verdict('H-1138-2026', { lot: '26J000059877-02', mfg_date: '2026-04-28' }, 'AFFECTED');
  verdict('H-1138-2026', { lot: '26J000059999-99', mfg_date: '2026-07-01' }, 'NOT_AFFECTED');
});

test('H-1224-2026: a lot printed with an internal space matches either way it is typed', () => {
  const c = clausesOf('H-1224-2026').find((x) => x.key === 'lot');
  assert.ok(c);
  assert.equal(c.test('LZ1 R169'), 'YES');
  assert.equal(c.test('lz1r169'), 'YES');
  assert.equal(c.test('LZ9 R999'), 'NO');
});

test('Z-2933-2026: a GS1 (01) GTIN and a device lot list are ANDed', () => {
  verdict('Z-2933-2026', { udi: '(01)20888937027451', lot: '25D2302Z' }, 'AFFECTED');
  verdict('Z-2933-2026', { udi: '20888937027451', lot: '99Z9999Z' }, 'NOT_AFFECTED');
  verdict('Z-2933-2026', { lot: '25D2302Z' }, 'NEED_CODE', 'UDI still unanswered');
});

test('H-1179-2026: "Best By codes range: 063026 through 093026" reads MMDDYY', () => {
  verdict('H-1179-2026', { best_by: '2026-07-30' }, 'AFFECTED');
  verdict('H-1179-2026', { best_by: '2026-10-30' }, 'NOT_AFFECTED');
});

test('H-1166-2026: a 13-digit typo in a list of 12-digit UPCs is kept, not dropped', () => {
  const c = clausesOf('H-1166-2026').find((x) => x.key === 'upc');
  assert.ok(c, 'the bare barcode list should be typed as a UPC list');
  assert.equal(c.test('8279120084732'), 'YES', 'the 13-digit source typo');
  assert.equal(c.test('827912008456'), 'YES', 'a well-formed neighbour');
  assert.equal(c.test('111111111111'), 'NO');
});

// ---------------------------------------------------------------------------
// Corpus-wide invariants — the safety net over all 13,480 frozen notices
// ---------------------------------------------------------------------------

test('INVARIANT: no notice clears a unit when the user supplied no codes at all', () => {
  const offenders: string[] = [];
  for (const n of NOTICES) if (evaluate(n, {}).verdict === 'NOT_AFFECTED') offenders.push(n.recall_number);
  assert.deepEqual(offenders.slice(0, 10), [], `${offenders.length} notices cleared a unit with no input`);
});

test('INVARIANT: no truncated or redacted notice ever returns NOT_AFFECTED', () => {
  const offenders: string[] = [];
  const bogus: UnitCodes = {
    lot: 'ZZ-000000', serial: 'ZZ-000000', model: 'ZZ-000000', upc: '000000000000',
    udi: '000000000000', best_by: '1999-01-01', expiry: '1999-01-01',
    mfg_date: '1999-01-01', julian: '99001', software: '0.0.0',
    plant: 'ZZ-000', date_code: 'ZZ-000000',
  };
  for (const n of NOTICES) {
    if (!n.code_info_truncated && !/x{3,}/i.test(n.code_info)) continue;
    if (evaluate(n, bogus).verdict === 'NOT_AFFECTED') offenders.push(n.recall_number);
  }
  assert.deepEqual(offenders.slice(0, 10), [], `${offenders.length} undecidable notices produced a clear`);
});

test('INVARIANT: a code the notice itself lists is never excluded by that notice', () => {
  // Tokens are drawn from `clause.source` — the FULL segment the clause compiled
  // from — not from `clause.evidence`, which is clipped for display. Reading the
  // clipped text would make this test circular: it would never see a code the
  // engine had already dropped, which is exactly how a segment-length cap once
  // let 389k of the corpus's code tokens fall outside every clause and produced
  // real false clears (H-0467-2026 lot MA250410 among them).
  let checked = 0;
  const offenders: string[] = [];
  const DATE_KEYS = new Set(['best_by', 'expiry', 'mfg_date', 'julian', 'date_code']);
  for (const n of NOTICES) {
    const p = parseCodeInfo(n.code_info, {
      contextYear: Number(n.report_date.slice(0, 4)),
      truncated: Boolean(n.code_info_truncated),
    });
    for (const c of p.clauses) {
      // Date keys are excluded: codeTokens is a code tokenizer, and running it
      // over date prose manufactures strings no owner would ever type.
      if (c.form !== 'list' || DATE_KEYS.has(c.key)) continue;
      for (const t of codeTokens(c.source).filter((x) => x.length >= 4)) {
        checked++;
        if (c.test(t) === 'NO') offenders.push(`${n.recall_number}:${c.key}:${t}`);
      }
    }
  }
  assert.ok(checked > 500_000, `expected a large sample, got ${checked}`);
  assert.deepEqual(
    offenders.slice(0, 5),
    [],
    `${offenders.length}/${checked} self-listed codes were excluded by their own notice`,
  );
});

test('INVARIANT: no notice clears a unit for a code printed with its own label word', () => {
  // Owners read codes off the package as printed. "Lot#894" must not clear
  // against a notice whose list holds "894".
  const offenders: string[] = [];
  for (const n of NOTICES) {
    const p = parseCodeInfo(n.code_info, {
      contextYear: Number(n.report_date.slice(0, 4)),
      truncated: Boolean(n.code_info_truncated),
    });
    for (const c of p.clauses) {
      if (c.form !== 'list' || c.key !== 'lot') continue;
      for (const t of codeTokens(c.source).filter((x) => x.length >= 4).slice(0, 6)) {
        for (const prefixed of [`LOT${t}`, `LOT#${t}`, `Lot ${t}`]) {
          if (c.test(prefixed) === 'NO') offenders.push(`${n.recall_number}:${prefixed}`);
        }
      }
    }
  }
  assert.deepEqual(offenders.slice(0, 5), [], `${offenders.length} label-prefixed codes were excluded`);
});

test('H-0467-2026: a lot 400 characters into the notice is still AFFECTED', () => {
  // Regression guard for the segment-length cap. MA250410 is the 50th lot in a
  // 544-character list; under the cap it read NOT_AFFECTED.
  verdict('H-0467-2026', { lot: 'N1003' }, 'AFFECTED', 'first lot in the list');
  verdict('H-0467-2026', { lot: 'MA250410' }, 'AFFECTED', 'lot past the old 400-char cap');
  verdict('H-0467-2026', { lot: 'MA250608' }, 'AFFECTED', 'last lot in the list');
  verdict('H-0467-2026', { lot: 'ZZ-9999' }, 'NOT_AFFECTED', 'a lot the notice does not list');
});

test('H-0503-2025: a lot typed as it is printed ("Lot#894") is AFFECTED', () => {
  verdict('H-0503-2025', { lot: '894' }, 'AFFECTED');
  verdict('H-0503-2025', { lot: 'Lot#894' }, 'AFFECTED');
  verdict('H-0503-2025', { lot: '999' }, 'NOT_AFFECTED');
});

test('INVARIANT: a fully-affected unit is never cleared by changing one code to another the notice names', () => {
  // The sharpest form of the safety property, and the one the per-clause tests
  // cannot reach: build a unit the notice's own text says is affected on EVERY
  // key, then swap one key for another code the same notice names. Every such
  // unit is still inside the recall, so a NOT_AFFECTED here is a false clear.
  //
  // This sweep found three real ones, all now closed: a lot past a 400-character
  // segment cap (H-0467-2026), the second band of "A through B and C through D"
  // (H-0908-2026), and a comma-separated date list whose leading dash read as a
  // range (H-0526-2025).
  const DATE_KEYS = new Set(['best_by', 'expiry', 'mfg_date']);
  // A code an owner could actually read off a label. Packaging descriptors
  // ("12/CS") and fragments of a longer code ("282" out of "(21)282") are things
  // the tokenizer sees and nobody types.
  const typeable = (v: string) =>
    /^[A-Za-z0-9._-]+$/.test(v) && v.replace(/[^A-Za-z0-9]/g, '').length >= 5 &&
    (v.match(/\d/g) ?? []).length >= 3;
  const candidates = (key: string, source: string): string[] => {
    if (DATE_KEYS.has(key)) return findDates(source).map((d) => d.text).slice(0, 8);
    if (key === 'julian') return (source.match(/\b\d{3,7}\b/g) ?? []).slice(0, 8);
    const out = new Set<string>();
    for (const t of atomicTokens(source)) if (typeable(t.raw)) out.add(t.raw);
    for (const t of codeTokens(source)) if (typeable(t)) out.add(t);
    return [...out].slice(0, 8);
  };

  let units = 0;
  const offenders: string[] = [];
  for (const n of NOTICES) {
    const p = parseCodeInfo(n.code_info, {
      contextYear: Number(n.report_date.slice(0, 4)),
      truncated: Boolean(n.code_info_truncated),
    });
    if (!p.clauses.length || p.sourceIncomplete) continue;
    const byKey = new Map<string, typeof p.clauses>();
    for (const c of p.clauses) byKey.set(c.key, [...(byKey.get(c.key) ?? []), c]);
    const group = (k: string, v: string) => anyOf(byKey.get(k)!.map((c) => c.test(v)));

    const affected = new Map<string, string>();
    for (const [k, cs] of byKey) {
      outer: for (const c of cs) for (const v of candidates(k, c.source)) {
        if (group(k, v) === 'YES') { affected.set(k, v); break outer; }
      }
    }
    if (affected.size !== byKey.size) continue; // no fully-affected unit to build

    for (const [k, cs] of byKey) {
      const alts = new Set<string>();
      for (const c of cs) for (const v of candidates(k, c.source)) alts.add(v);
      for (const v of alts) {
        units++;
        // Cheap screen first: a clear needs this key to say NO with nothing
        // unresolved. Only then pay for a full evaluate(), which re-parses.
        if (group(k, v) !== 'NO') continue;
        const unit = { ...Object.fromEntries(affected), [k]: v } as UnitCodes;
        if (evaluate(n, unit).verdict === 'NOT_AFFECTED') {
          offenders.push(`${n.recall_number} ${k}=${v}`);
        }
      }
    }
  }
  assert.ok(units > 40_000, `expected a large sweep, got ${units} units`);
  assert.deepEqual(offenders.slice(0, 5), [], `${offenders.length}/${units} units were falsely cleared`);
});

test('INVARIANT: the engine parses the whole corpus without throwing', () => {
  for (const n of NOTICES) {
    const a = evaluate(n, { lot: 'A1', best_by: '2026-01-01', model: 'X1' });
    assert.ok(['AFFECTED', 'NOT_AFFECTED', 'NEED_CODE'].includes(a.verdict), n.recall_number);
    if (a.verdict === 'NEED_CODE') {
      assert.ok(a.questions.length > 0, `${n.recall_number} asked for a code without naming one`);
    }
  }
});
