/**
 * src/card.ts — the result card.
 *
 * One renderer, two consumers: the CLI below writes a standalone HTML file, and
 * src/mcp-server.ts hands the same markup to the web client so a verdict looks
 * identical wherever it is read.
 *
 * Everything a reader needs to check our work is on the card: the verdict, the
 * exact `code_info` text the predicate engine reasoned over, each clause and how
 * it resolved, the firm's own words for the reason and the remedy, and a link to
 * the primary source notice. Nothing here is paraphrased.
 */

import type { Result } from './match.ts';
import type { ClauseResult, Verdict } from './predicates.ts';

const esc = (s: string): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => `&${({ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' }[c])};`);

const flat = (s: string): string => String(s ?? '').replace(/\s+/g, ' ').trim();

const LABEL: Record<Verdict, string> = {
  AFFECTED: 'Affected',
  NOT_AFFECTED: 'Not affected',
  NEED_CODE: 'Need a code',
};

const KEY_LABEL: Record<string, string> = {
  lot: 'Lot code',
  best_by: 'Best-by date',
  expiry: 'Expiry date',
  mfg_date: 'Manufacture date',
  julian: 'Julian date code',
  date_code: 'Date code',
  model: 'Model number',
  serial: 'Serial number',
  upc: 'UPC / barcode',
  udi: 'UDI',
  software: 'Software version',
  plant: 'Plant / establishment',
};

const MARK: Record<string, string> = { YES: 'in scope', NO: 'outside scope', UNKNOWN: 'unresolved' };

const keyLabel = (k: string): string => KEY_LABEL[k] ?? k.replace(/_/g, ' ');

function clauseRow(c: ClauseResult): string {
  return `<tr class="r-${c.result.toLowerCase()}">
      <td class="k">${esc(keyLabel(c.key))}</td>
      <td class="g">${c.given ? esc(c.given) : '<span class="none">not supplied</span>'}</td>
      <td class="v">${MARK[c.result]}</td>
      <td class="e"><code>${esc(flat(c.evidence))}</code></td>
    </tr>`;
}

/** One verdict, as a self-contained `<article>`. Safe to inject: everything is escaped. */
export function renderCard(r: Result): string {
  const a = r.assessment;
  const n = r.notice;
  const meta = [n.recall_number, n.domain, n.status, n.classification, n.report_date]
    .filter(Boolean)
    .map((s) => `<span>${esc(s)}</span>`)
    .join('');

  const blocks: string[] = [];

  blocks.push(`<section class="block">
      <h3>Code information on the notice, verbatim</h3>
      <blockquote>${esc(flat(r.codeInfo)) || '<span class="none">The notice states no code.</span>'}</blockquote>
      ${n.code_info_truncated ? `<p class="warn">Source text runs to ${n.code_info_truncated.toLocaleString()} characters and is truncated in this snapshot. No unit can be cleared against it.</p>` : ''}
    </section>`);

  if (a.clauses.length) {
    blocks.push(`<section class="block">
      <h3>How the verdict was reached</h3>
      <table><thead><tr><th>Code</th><th>Your unit</th><th>Result</th><th>Rule read from the notice</th></tr></thead>
      <tbody>${a.clauses.map(clauseRow).join('')}</tbody></table>
    </section>`);
  }

  if (a.questions.length) {
    blocks.push(`<section class="block ask">
      <h3>To decide this, we need</h3>
      <ul>${a.questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>
    </section>`);
  }

  if (a.caveats.length) {
    blocks.push(`<section class="block">
      <h3>Caveats</h3>
      <ul>${a.caveats.map((c) => `<li>${esc(flat(c))}</li>`).join('')}</ul>
    </section>`);
  }

  if (r.reason) {
    blocks.push(`<section class="block">
      <h3>Reason for the recall, verbatim</h3>
      <blockquote>${esc(flat(r.reason))}</blockquote>
    </section>`);
  }

  // A remedy is instruction, so it is shown only where it applies and only in the
  // issuer's own words. openFDA enforcement records carry no remedy field at all.
  if (a.verdict !== 'NOT_AFFECTED') {
    blocks.push(`<section class="block">
      <h3>Remedy, verbatim from the issuing agency</h3>
      ${r.remedy
        ? `<blockquote>${esc(flat(r.remedy))}</blockquote>`
        : '<p class="none">This record carries no remedy text. Follow the primary source notice.</p>'}
    </section>`);
  }

  return `<article class="card ${a.verdict}">
    <header>
      <p class="badge">${LABEL[a.verdict]}</p>
      <h2 title="${esc(flat(n.product_description))}">${esc(flat(n.product_description))}</h2>
      <p class="firm">${esc(n.firm)}</p>
      <p class="meta">${meta}</p>
    </header>
    <p class="lede">${esc(a.reason)}</p>
    ${blocks.join('\n')}
    <footer>
      ${n.url
        ? `<a href="${esc(n.url)}" rel="noreferrer noopener" target="_blank">Primary source notice</a>`
        : `<span class="none">The source record carries no usable link; search the agency site for ${esc(n.recall_number)}.</span>`}
      ${r.duplicates.length ? `<span class="dupes">Same event, also filed as ${esc(r.duplicates.slice(0, 4).join(', '))}</span>` : ''}
    </footer>
  </article>`;
}

/** Shared stylesheet. The web client inlines this too, so a card looks the same in both. */
export const CARD_CSS = `
.card {
  --ink: #16181d; --dim: #6b7079; --line: #e2e2df; --paper: #fbfbf9;
  --tone: #6b7079; --wash: #f3f3f0;
  background: var(--paper); color: var(--ink); border: 1px solid var(--line);
  border-left: 3px solid var(--tone); border-radius: 6px;
  padding: 20px 22px; margin: 0 0 16px;
  font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
}
.card.AFFECTED     { --tone: #a3231c; --wash: #fbf0ef; }
.card.NOT_AFFECTED { --tone: #2f6b45; --wash: #eef4f0; }
.card.NEED_CODE    { --tone: #8a6412; --wash: #faf5e8; }
.card header { margin-bottom: 12px; }
.card .badge {
  display: inline-block; margin: 0 0 8px; padding: 3px 9px; border-radius: 3px;
  background: var(--wash); color: var(--tone);
  font-size: 11.5px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase;
}
.card h2 {
  margin: 0 0 4px; font-size: 18px; line-height: 1.3; font-weight: 600;
  /* Notices list every pack size in one description field; show the first lines. */
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.card .firm { margin: 0; color: var(--dim); font-size: 13.5px; }
.card .meta { margin: 8px 0 0; display: flex; flex-wrap: wrap; gap: 6px; }
.card .meta span {
  border: 1px solid var(--line); border-radius: 3px; padding: 1px 7px;
  color: var(--dim); font-size: 11.5px;
}
.card .lede { margin: 0 0 18px; font-size: 15.5px; }
.card .block { border-top: 1px solid var(--line); padding-top: 13px; margin-top: 13px; }
.card .block h3 {
  margin: 0 0 8px; font-size: 11.5px; font-weight: 650; letter-spacing: .07em;
  text-transform: uppercase; color: var(--dim);
}
.card blockquote {
  margin: 0; padding: 10px 12px; background: #fff; border: 1px solid var(--line); border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; line-height: 1.6;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.card .block.ask ul { margin: 0; padding-left: 18px; }
.card .block.ask li { margin-bottom: 4px; }
.card ul { margin: 0; padding-left: 18px; color: var(--ink); }
.card table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.card th {
  text-align: left; font-weight: 600; color: var(--dim); font-size: 11px;
  letter-spacing: .05em; text-transform: uppercase; padding: 0 10px 6px 0;
}
.card td { padding: 6px 10px 6px 0; border-top: 1px solid var(--line); vertical-align: top; }
.card td.k { white-space: nowrap; font-weight: 550; }
.card td.g { white-space: nowrap; font-family: ui-monospace, Menlo, monospace; }
.card td.v { white-space: nowrap; }
.card td.e code { font-family: ui-monospace, Menlo, monospace; color: var(--dim); overflow-wrap: anywhere; }
.card tr.r-yes td.v  { color: #a3231c; }
.card tr.r-no td.v   { color: #2f6b45; }
.card tr.r-unknown td.v { color: #8a6412; }
.card .none { color: var(--dim); font-style: italic; }
.card .warn { margin: 8px 0 0; color: #8a6412; font-size: 13px; }
.card footer {
  border-top: 1px solid var(--line); margin-top: 14px; padding-top: 12px;
  display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; font-size: 12.5px;
}
.card footer a { color: var(--tone); }
.card .dupes { color: var(--dim); }
@media (prefers-color-scheme: dark) {
  .card {
    --ink: #e8e8e4; --dim: #9a9ea6; --line: #32343a; --paper: #191b1f; --wash: #23252a;
  }
  .card.AFFECTED     { --tone: #e8756a; --wash: #2a1e1d; }
  .card.NOT_AFFECTED { --tone: #6fbf8f; --wash: #1a241e; }
  .card.NEED_CODE    { --tone: #d9ae55; --wash: #272117; }
  .card blockquote { background: #121316; }
  .card tr.r-yes td.v { color: #e8756a; }
  .card tr.r-no td.v { color: #6fbf8f; }
  .card tr.r-unknown td.v { color: #d9ae55; }
}
`;

/** A standalone, dependency-free HTML file holding one or more cards. */
export function cardPage(title: string, results: Result[]): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { margin: 0; padding: 32px 20px; background: #f2f2ef; }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font: 600 20px/1.3 ui-sans-serif, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; margin: 0 0 20px; color: #16181d; }
  @media (prefers-color-scheme: dark) { body { background: #101114; } h1 { color: #e8e8e4; } }
${CARD_CSS}
</style>
</head><body><main>
<h1>${esc(title)}</h1>
${results.map(renderCard).join('\n') || '<p>No recall notice in the frozen snapshot matches that product.</p>'}
</main></body></html>`;
}

// ---------------------------------------------------------------------------
// CLI:  node src/card.ts "kroger grade a eggs" --julian=173 --out=card.html
// ---------------------------------------------------------------------------

if (import.meta.filename === process.argv[1]) {
  const { openIndex } = await import('./match.ts');
  const { writeFileSync } = await import('node:fs');
  const unit: Record<string, string> = {};
  const q: Record<string, unknown> = { limit: 3 };
  const text: string[] = [];
  let out = 'card.html';
  for (const arg of process.argv.slice(2)) {
    const m = /^--([a-z_]+)=(.*)$/.exec(arg);
    if (!m) { text.push(arg); continue; }
    if (m[1] === 'out') out = m[2];
    else if (m[1] === 'limit') q.limit = Number(m[2]);
    else if (m[1] === 'domain') q.domain = m[2];
    else if (m[1] === 'upc') { q.upc = m[2]; unit.upc = m[2]; }
    else unit[m[1]] = m[2];
  }
  q.text = text.join(' ');
  const idx = openIndex();
  const results = idx.check(q as never, unit as never);
  writeFileSync(out, cardPage(q.text ? `Recall check: ${q.text}` : 'Recall check', results));
  idx.close();
  console.log(`${out} — ${results.length} card(s): ${results.map((r) => r.assessment.verdict).join(', ')}`);
}
