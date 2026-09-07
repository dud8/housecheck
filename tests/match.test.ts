/**
 * tests/match.test.ts — resolution and end-to-end verdicts. Plain `node --test`.
 *
 * These cover the half of the problem a search box already solves (finding the
 * notice) and prove the handoff into the predicate engine: the same product,
 * found the same way, returns different verdicts for different units.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openIndex, upcKey, barcodesIn, safeUrl } from '../src/match.ts';
import type { Index } from '../src/match.ts';

let idx: Index;
before(() => {
  idx = openIndex();
});
after(() => idx.close());

const only = (recallNumber: string, rs: Array<{ notice: { recall_number: string } }>) =>
  rs.find((r) => r.notice.recall_number === recallNumber);

test('upcKey folds UPC-12, EAN-13 and GTIN-14 onto one key', () => {
  assert.equal(upcKey('0 11110-60902 1'.replace(/\s/g, '')), '11110609021');
  assert.equal(upcKey('011110609021'), upcKey('00011110609021'));
  assert.equal(upcKey('11110609021'), upcKey('011110609021'));
});

test('barcodesIn rejoins a UPC printed with spaces and dashes', () => {
  assert.ok(barcodesIn('Net Wt 21 oz, UPC 0 11110-60902 1.').includes('11110609021'));
});

test('H-1230-2026 is reachable by the exact UPC printed on the Kroger carton', () => {
  const hits = idx.search({ upc: '011110609021' });
  const hit = only('H-1230-2026', hits);
  assert.ok(hit, 'exact barcode lookup missed the eggs notice');
  assert.equal(hit.why, 'upc');
});

test('H-1230-2026 is reachable by free text through FTS5', () => {
  const hits = idx.search({ text: 'Kroger Grade A White In-shell Chicken eggs', domain: 'food', limit: 20 });
  assert.ok(only('H-1230-2026', hits), 'full-text search missed the eggs notice');
});

test('a misspelled query still resolves through the fuzzy prefix fallback', () => {
  const hits = idx.search({ text: 'krog grade white inshell chick egg', domain: 'food', limit: 20 });
  assert.ok(hits.length > 0, 'fuzzy fallback returned nothing');
});

test('the same product with two different Julian codes gets two different verdicts', () => {
  const q = { upc: '011110609021', limit: 3 };
  const affected = only('H-1230-2026', idx.check(q, { lot: 'P-1950', julian: '173', best_by: '2026-08-01' }));
  const cleared = only('H-1230-2026', idx.check(q, { lot: 'P-1950', julian: '200', best_by: '2026-09-01' }));
  assert.equal(affected?.assessment.verdict, 'AFFECTED');
  assert.equal(cleared?.assessment.verdict, 'NOT_AFFECTED');
});

test('a verdict always carries the source link and the exact code text', () => {
  const r = only('H-1230-2026', idx.check({ upc: '011110609021' }, { lot: 'P-1950' }));
  assert.ok(r);
  assert.match(r.source, /^https?:\/\//);
  assert.match(r.codeInfo, /Julian Date between 157 and 184/);
  assert.ok(r.reason.length > 0, 'the recall reason must be available verbatim');
});

test('CPSC notices carry the official remedy verbatim (openFDA has no remedy field)', () => {
  const cpsc = only('26733', idx.check({ text: 'Loyoda adult portable bed rails', domain: 'consumer', limit: 5 }, {}));
  assert.ok(cpsc, 'expected the Loyoda bed rail recall');
  assert.ok(cpsc.remedy.length > 0);
  const fda = only('H-1230-2026', idx.check({ upc: '011110609021' }, {}));
  assert.equal(fda?.remedy, '', 'openFDA enforcement records have no remedy field');
});

test('duplicate recall numbers for one event are grouped, not matched away', () => {
  const r = only('H-1230-2026', idx.check({ upc: '011110609021' }, {}));
  assert.ok(r);
  assert.ok(r.duplicates.includes('H-1229-2026'), 'the sibling notice should be listed as the same event');
});

test('results are ordered AFFECTED, then NEED_CODE, then NOT_AFFECTED', () => {
  const rank: Record<string, number> = { AFFECTED: 0, NEED_CODE: 1, NOT_AFFECTED: 2 };
  const rs = idx.check({ text: 'in-shell chicken eggs', domain: 'food', limit: 10 }, { julian: '173' });
  const seq = rs.map((r) => rank[r.assessment.verdict]);
  assert.deepEqual(seq, [...seq].sort((a, b) => a - b), 'verdict ordering is not monotone');
});

test('an unrecalled product returns no candidates rather than a wrong one', () => {
  assert.equal(idx.search({ upc: '999999999999' }).length, 0);
});

test('the index covers the whole frozen snapshot', () => {
  assert.equal(idx.notices.length, 13_480);
});

test('every source link resolves: no malformed or non-http URL survives loading', () => {
  // Two CPSC records ship "https:/www…" and "hhttps://…". A verdict promises a
  // link to the primary source, so a dead one is a broken promise.
  const bad = idx.notices.filter((n) => n.url && !/^https?:\/\/[^/]+\//.test(n.url));
  assert.deepEqual(bad.slice(0, 3).map((n) => n.recall_number), []);
  assert.equal(safeUrl('https:/www.cpsc.gov/Recalls/2026/X'), 'https://www.cpsc.gov/Recalls/2026/X');
  assert.equal(safeUrl('hhttps://www.cpsc.gov/Recalls/2023/Y'), 'https://www.cpsc.gov/Recalls/2023/Y');
  assert.equal(safeUrl('javascript:alert(1)'), '');
});
