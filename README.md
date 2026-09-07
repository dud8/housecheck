# HouseCheck

**A search engine can tell you a product was recalled. It cannot tell you whether
*your* unit is one of them. HouseCheck can.**

Recall notices almost never say "this product is recalled". They say:

> Codes P-1950 or 0840962 with a Julian Date between 157 and 184 and a Best
> By/Sell By date Between July 20 - August 17, 2026

— recall **H-1230-2026**, Class I, still Ongoing, verbatim from the FDA.

Two cartons of the same eggs, same barcode, sitting in two different fridges: one
is under a Class I *Salmonella* recall and the other is fine. Every recall tool
we could find searches product titles and shows you the notice. HouseCheck reads
that sentence, compiles it into a decidable predicate, and tests the codes
printed on **your** carton against it.

```
$ node src/match.ts --upc="0 11110-60902 1" --lot=P-1950 --julian=173 --best_by=2026-08-01

AFFECTED  H-1230-2026  [food, Ongoing]
  The julian you gave (173) ... every code the notice names matches this unit.
    [YES] lot     = P-1950      :: "Codes P-1950 or 0840962 with a"
    [YES] julian  = 173         :: "Julian Date between 157 and 184 and a"
    [YES] best_by = 2026-08-01  :: "Best By/Sell By date Between July 20 - August 17, 2026"

$ node src/match.ts --upc="0 11110-60902 1" --lot=P-1950 --julian=200 --best_by=2026-09-01

NOT_AFFECTED  H-1230-2026  [food, Ongoing]
  The julian you gave (200) is outside the recalled set, and every other code in
  the notice was checked.
    [YES] lot     = P-1950      :: "Codes P-1950 or 0840962 with a"
    [NO]  julian  = 200         :: "Julian Date between 157 and 184 and a"
    [NO]  best_by = 2026-09-01  :: "Best By/Sell By date Between July 20 - August 17, 2026"

$ node src/match.ts --upc="0 11110-60902 1"

NEED_CODE  H-1230-2026  [food, Ongoing]
  The notice narrows the recall to specific codes that this unit has not supplied.
    ask: What is the Julian date code (the 3 to 5 digit production code) on the
         package? (printed on the left or right sides of the carton.)
```

Same product. Same barcode. Three different answers, because the unit is
different. That is the whole idea.

---

## Run it

Node 22.18 or newer, nothing else. Node runs the TypeScript directly, so there is
no build step.

```bash
npm install          # one dependency: @modelcontextprotocol/sdk (+ zod)
npm test             # 55 assertions over the real frozen notices
npm run serve        # http://127.0.0.1:8765
```

Open <http://127.0.0.1:8765/> and type `0 11110-60902 1`.

There is **no network access at runtime and no API key**. Every notice is read
from `data/recalls.json`, a snapshot committed to this repo. Judges can run this
on a plane.

---

## The three verdicts

| verdict | means | when |
|---|---|---|
| `AFFECTED` | this unit is in the recall | every rule the notice names matched |
| `NOT_AFFECTED` | this unit is outside the recall | every rule was evaluated against a code the owner actually supplied, and at least one definitively excluded the unit |
| `NEED_CODE` | cannot decide yet, **here is the question to ask** | any rule is unresolved |

`NEED_CODE` is a feature. **A false clear is the worst thing this software could
do** — telling somebody their infant formula is fine when it is under a Class I
recall. So `NOT_AFFECTED` is the only verdict with a burden of proof, and every
kind of doubt resolves the other way:

- The notice's own text is truncated or the source redacted the codes
  (`Lots: 2007xxxxx to 2012xxxxx`) → never `NOT_AFFECTED`, no matter what codes
  the owner supplies.
- The code text is ambiguous (`06/08/28` is both June 8 2028 and 6 August 2028) →
  every reading is carried as a separate hypothesis and the unit is affected if
  **any** of them says so.
- The notice names no code at all → the whole product is in scope, `AFFECTED`.
- A rule cannot be evaluated because the owner has not supplied that code →
  `NEED_CODE` with the exact question, in the notice's own words including where
  the code is printed.

Asserted over the whole corpus in `tests/`, not on a sample:

- No notice returns `NOT_AFFECTED` for an owner who supplied no codes.
- No truncated or redacted notice returns `NOT_AFFECTED` at all.
- Of 569,386 codes the notices themselves list, not one is excluded by its own
  notice.
- Build a unit that a notice's own text says is affected on **every** key, then
  swap one key for another code the same notice names: across 94,733 such units
  none is cleared. That sweep is how three real false clears were found and
  closed — a lot 400 characters into a list, the second band of "A through B and
  C through D", and a comma-separated date list whose leading dash read as a
  range.

---

## Architecture

```
data/recalls.json          13,480 frozen notices  (openFDA x3 + CPSC, fetched 2026-09-07)
data/manifest.json         fetch date + every request URL, so the snapshot is reproducible
data/fetch.ts              re-runs the ingestion
data/CODE_INFO_TAXONOMY.md the 25 shapes of code_info text, measured over the corpus

src/predicates.ts   the crown jewel — code_info free text -> decidable predicate
src/match.ts        resolve a product to candidate notices (SQLite FTS5 + barcode)
src/card.ts         the result card, one renderer for the CLI and the web client
src/mcp-server.ts   MCP over Streamable HTTP, spec 2025-11-25 + static web client

web/index.html      simulated Alexa+ client: conversational UI, talks MCP over HTTP
tests/              55 assertions, plain `node --test`, no framework
```

### `src/predicates.ts` — the part that matters

Not 25 regexes. One pipeline:

```
scan code_info for field labels ("Lot:", "Best By", "Julian Date", "UDI-DI")
  -> slice the value segments between them
  -> classify each value's shape: universal | cutoff | range | prefix | list
  -> compile a Clause with test(value) -> YES | NO | UNKNOWN
```

Clauses sharing a key are ORed (a notice listing "lot A made 27 Apr" and "lot B
made 28 Apr" recalls either). Distinct keys are ANDed (a model gate **and** a lot
list means both must hold). Twelve key kinds: `lot, best_by, expiry, mfg_date,
julian, date_code, model, serial, upc, udi, software, plant`.

Ambiguity is never resolved by a coin flip; it becomes a **disjunction of
hypotheses**. `Julian Dates 3355 to 1536 (mfg. 12/01/2025 to 06/02/2026)` is
`DDDY`, not `YYDDD` — day 335 of 2025 to day 153 of 2026 — and a naive numeric
compare inverts the range. So every valid decoding is kept, the unit is
`AFFECTED` if any hypothesis says so, and `NOT_AFFECTED` only if all of them do.

95,475 clauses over 13,480 notices, parsed and evaluated in about 1.1 seconds.

**What the corpus actually looks like**, measured, not estimated:

| | notices | share |
|---|---:|---:|
| unit-decidable — two owners can get two different verdicts | 9,736 | **72.2%** |
| whole product — every unit in scope, no code needed | 3,479 | 25.8% |
| undecidable — source truncated or redacted the codes | 265 | 2.0% |

That 72.2% is the gap this project closes.

### `src/mcp-server.ts` — MCP over Streamable HTTP

```
POST http://127.0.0.1:8765/mcp     spec 2025-11-25, stateless, JSON responses
```

Five tools, each calling the engine above — nothing in the server re-implements
matching or restates a verdict:

| tool | for |
|---|---|
| `check_recall` | **the main one.** product + whatever codes are on the package → a verdict per notice, with the next question when it is `NEED_CODE` |
| `search_product` | which notices could be about this product, no verdict — the thing every other tool stops at |
| `explain_verdict` | one notice, clause by clause: each rule, the owner's value, in or out |
| `get_remedy` | the agency's own instructions, verbatim, plus a source link |
| `list_recent_recalls` | recent notices, filterable by category, status and hazard class |

Tool and field descriptions are written for an agent that has never seen a recall
notice — it has to know from the schema alone that a "Julian date code" is the 3
to 5 digit production code, and that `NEED_CODE` means *ask this question and
call again*.

```bash
curl -s -X POST http://127.0.0.1:8765/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"check_recall",
        "arguments":{"upc":"0 11110-60902 1","lot":"P-1950","julian":"173","best_by":"2026-08-01"}}}'
```

Both `Accept` values are required by the transport. Point any MCP client at
`http://127.0.0.1:8765/mcp` with transport `http`.

### `web/` — the client

A single HTML file. It speaks MCP over Streamable HTTP with `fetch`, holds a
short conversation, and renders the result card the server sends back. Type a
product or a barcode; when the server answers `NEED_CODE`, the next thing you
type fills the code it asked for.

No frameworks, no build, no assets. It reads as a calm assistant rather than a
debug console because the point being demonstrated — one product, two codes, two
verdicts — has to survive a two-minute video.

### `src/card.ts` — the result card

One renderer, used by the web client and by a standalone-file CLI:

```bash
node src/card.ts "kroger grade a eggs" --lot=P-1950 --julian=173 --best_by=2026-08-01 --out=card.html
```

Every card carries the verdict, **the exact `code_info` text the engine reasoned
over**, a row per rule showing the owner's value and whether it fell inside or
outside, the recall reason verbatim, the remedy verbatim where the source has
one, and a link to the primary source notice. Nothing on a card is paraphrased,
and no safety or medical advice is added to what the agency wrote.

---

## Data

Fetched 2026-09-07. Keyless, public, no account:

| source | notices | report dates |
|---|---:|---|
| `api.fda.gov/food/enforcement.json` | 4,000 | 2023-12-20 → 2026-08-19 |
| `api.fda.gov/drug/enforcement.json` | 3,000 | 2023-02-22 → 2026-08-19 |
| `api.fda.gov/device/enforcement.json` | 4,000 | 2025-04-23 → 2026-08-19 |
| `saferproducts.gov/RestWebServices/Recall` | 2,480 | 2019-01-30 → 2026-09-03 |

`data/manifest.json` records every request URL. `node data/fetch.ts` re-runs the
whole ingestion; 12 requests total, against a limit of 240/min and 1,000/day.

Two ingestion decisions worth knowing:

- `code_info` is capped at 20,000 characters. 243 device notices inline every
  affected serial number — the largest is **8.8 MB** of comma-separated lots.
  Each capped record keeps `code_info_truncated` with the true length, and the
  matcher routes those to `NEED_CODE` rather than reason over a partial list and
  risk a false clear.
- CPSC has no `code_info` field; its qualifiers live in the recall prose, so
  `Description` is mapped in and parsed identically.

---

## Tests

```bash
npm test          # or: node --test
# tests 55   pass 55   fail 0
```

Every assertion names the `recall_number` it is about and reads that notice out
of the frozen snapshot — no fixtures, no invented code text. Plain `node --test`;
no jest, no vitest, no config.

Note: `node --test tests/` **fails** — Node treats the directory as a module
path. Use bare `node --test` or `node --test tests/*.test.ts`.

---

## Known limits

Listed because a safety tool that hides its edges is worse than one that does
not have them. **Every one of these degrades to `NEED_CODE` or over-flags. None
of them can produce a false clear.**

1. **GS1 AI decomposition.** `(17)280501(10)0001441871` matches as a UDI string,
   but the embedded `(17)` expiry and `(10)` lot are not pulled out as
   independent keys. 420 notices lose a free second key.
2. **Interleaved drug lot/expiry binding.** `Lot #s: 22142448, Exp 5/2024;
   22143845, Exp 7/2024` binds each expiry to the run of lots before it. We
   parse lots and expiries as separate ORed groups, so a pairing that does not
   exist in the source still returns `AFFECTED`.
3. **Timestamp windows.** `Plant Code: PLT19-145 Timestamp: 17:51 to 21:23` —
   only part of one shift is recalled; we flag the whole day.
4. **Serial layouts that differ from the notice's own** return `UNKNOWN` rather
   than guess at a comparison between differently-shaped codes.
5. **Declared date-code layouts are inferred, not consumed.** When a notice
   states `YYDDD`, we re-derive it instead of reading the declaration.
6. **CPSC size ranges** ("sizes 2T through 5T") emit no clause, so the whole
   product is flagged.
7. **Slash-joined headers** — `REF/UDI-DI/Serial/Lot: PRT-00853/003897.../155391P`
   parse as one list rather than four positional fields.

And the standing limit that is not a bug: the snapshot is a fixed window. "No
notice matches" is not a clearance, and the tool says so in those words.

---

## Product feedback

Required by the hackathon, and the honest version is in
[`FRICTION_LOG.md`](FRICTION_LOG.md) — written during the build, not
reconstructed afterwards, with each entry naming the file or line the friction
changed. It covers all six tools used, each with what it was for, what worked,
what needs work, onboarding, and whether we would use it again.

The short version:

**`@modelcontextprotocol/sdk` 1.30.0 — Streamable HTTP.** Would use again.
`LATEST_PROTOCOL_VERSION` is already `2025-11-25`, so the required revision needs
no configuration, and `registerTool` generates the `tools/list` JSON Schema from
the Zod shape including every `.describe()` string. Three things cost time:
installing it broke a working project, because Node 22 runs `.ts` natively and
HouseCheck had no `package.json` until then — `npm init -y` writes
`"type": "commonjs"` and 50 passing tests became 50 failures pointing at files we
had not touched. Second, the transport rejects any request whose `Accept` header
is not *both* `application/json` and `text/event-stream`, even with
`enableJsonResponse: true`; the natural first `curl` fails. Third, returning
`structuredContent` alongside text works when a tool declares no `outputSchema` —
which is what let one tool call serve both a spoken summary and a rendered card —
but we only know it is supported by reading the compiled `dist`. A page called
"what your HTTP client must send" would have saved all of it.

**openFDA enforcement API.** Would use again; it is the reason this project
exists. `code_info` is the richest free-text field in any public safety dataset.
But it returns **HTTP 404 for an exhausted page** rather than an empty result
set, there is **no remedy field at all** on the enforcement endpoints — so a
safety tool literally cannot tell anyone what to do without linking out — and the
only citable URL per notice is a **JSON API query**, not a page a person can
read.

**CPSC saferproducts.** Complementary rather than equivalent: 2,479 of 2,480
records carry a remedy, which is exactly what openFDA lacks, but there is no
`code_info` field, so the qualifiers have to be mined out of prose.

**`node:sqlite` + FTS5, Node 22 native TypeScript, `node:test`.** All three would
be used again, and together they are why this repo has one dependency and no
build step. `spellfix1` is not compiled into Node's SQLite (checked, not
assumed), so fuzzy matching is a prefix-query fallback.

---

## License

MIT — see [`LICENSE`](LICENSE).

Recall data is public-domain output of the U.S. FDA and CPSC. Every verdict links
its primary source notice, and agency text is reproduced verbatim and unedited.

HouseCheck is not affiliated with, endorsed by, or connected to Amazon, the FDA
or the CPSC. It is an information tool, not safety or medical advice: read the
primary source notice and follow the recalling firm's instructions.
