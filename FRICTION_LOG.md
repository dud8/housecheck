# Friction log

Written while building, not reconstructed afterwards. Each entry names the
file or line the friction changed. Where something worked, it says so plainly
and briefly; the useful part of a log like this is the part that cost time.

Tools covered: openFDA enforcement API, CPSC saferproducts REST API,
`node:sqlite`, Node 22 native TypeScript, `node:test`, and
`@modelcontextprotocol/sdk`. Each section says what it was used for, what
worked, what needs work, and whether we would use it again.

---

## openFDA enforcement API

**Used for.** Every FDA notice in the corpus: 4,000 food, 3,000 drug, 4,000
device records pulled by `data/fetch.ts` in eleven requests
(`?sort=report_date:desc&limit=1000&skip=N`). The `code_info` field is the whole
technical premise of the project — it is the free text that `src/predicates.ts`
compiles into predicates.

**Onboarding.** The best part of the API. No key, no account, no signup, no
terms click-through. `curl 'https://api.fda.gov/food/enforcement.json?limit=1'`
returns useful JSON on the first try. The unauthenticated budget (240 req/min,
1,000 req/day per IP) is generous enough that the entire corpus cost eleven of
the thousand. Nothing else in this build was that easy to start.

**What worked.**
- `limit=1000` is honoured, so paging is cheap and the whole snapshot is one
  short script.
- Field names are stable across the food, drug and device endpoints, so one
  mapper handles all three.
- `report_date` is a clean `YYYYMMDD` string; converting it is three lines.

**What needs work.**

1. **An empty page returns HTTP 404, not an empty `results` array.** Paging past
   the end looks like an error. `data/fetch.ts` has to special-case
   `if (res.status === 404) return null` to tell "no more records" apart from a
   real failure. A 200 with `results: []` would be correct and would remove a
   genuine ambiguity: a real 404 and an exhausted cursor are now
   indistinguishable without inspecting the body.

2. **`code_info` has no schema, no delimiter convention, and no length bound.**
   Twenty-five distinct pattern classes appear in 13,480 records
   (`data/CODE_INFO_TAXONOMY.md`). One device record carries **8.8 MB** of
   comma-separated serial numbers inline; 243 records exceed 20,000 characters.
   The snapshot caps the field and marks `code_info_truncated`, and the matcher
   routes every capped record to NEED_CODE, because reasoning over a partial
   list is exactly how a checker produces a false clear. A `code_info` array, or
   even a nullable `code_info_url` for the oversized ones, would turn the single
   hardest part of this project into a normal parsing job.

3. **`more_code_info` carries the overflow and is easy to miss.** It is a
   second field holding the continuation of `code_info`; if it is not
   concatenated, codes are silently lost with no signal that anything was
   dropped. `data/fetch.ts` joins the two.

4. **The enforcement endpoints have no remedy field at all.** 0 of 11,000 FDA
   records carry one; all 11,000 carry `reason_for_recall`. For a tool that must
   surface official instructions verbatim and never editorialise, that is a real
   gap: we can tell someone their unit is affected and quote why, but we cannot
   tell them what the firm says to do about it. `src/match.ts` exposes `reason`
   verbatim and leaves `remedy` empty rather than inventing one.

5. **There is no stable consumer-facing URL per recall.** The only citation we
   can construct is
   `https://api.fda.gov/food/enforcement.json?search=recall_number:"H-1230-2026"`,
   which is a JSON API query, not a page a person can read. Handing that to
   someone standing in their kitchen is bad, and it is the one place where the
   product has to link out and cannot. A `recall_url` field pointing at the FDA
   press release, where one exists, would fix it.

6. **`recall_number` is not always populated.** One record in the snapshot has
   `"N/A"`; `data/fetch.ts` falls back to `event_id` plus offset to keep ids
   unique. Small, but it breaks the obvious primary-key assumption.

7. **One event spans several recall numbers with byte-identical `code_info`.**
   `H-1229-2026` and `H-1230-2026` are the same Midwest Poultry egg recall.
   There is no event-level grouping key exposed, so `src/match.ts` groups on
   `firm + code_info` — a heuristic that works but should not be necessary when
   `event_id` is right there.

**Would we build with it again.** Yes, without hesitation. It is the only
keyless source of structured US recall data with this depth, and the rate limit
is not a constraint at our volume. The friction is in the shape of `code_info`,
and that same shape is the reason this project has anything to build.

---

## CPSC saferproducts REST API

**Used for.** 2,480 consumer-product recalls back to 2019, in a single request:
`https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=2019-01-01`.

**Onboarding.** Also keyless. The whole dataset arrives in one response, which
is pleasant, though it means there is no way to fetch incrementally except by
date and no way to know the response size in advance.

**What worked.** Rich structured sub-objects: `Products[]`, `Hazards[]`,
`Remedies[]`, `Retailers[]`, `ManufacturerCountries[]`. Unlike FDA, CPSC gives
a real consumer-facing `URL` per recall and a real remedy string (2,479 of
2,480 records have one), which is what a safety tool actually needs to show.

**What needs work.**

1. **There is no `code_info` equivalent.** The lot codes, date codes, model
   numbers and manufacture-date cutoffs that decide whether a specific unit is
   affected are buried in the `Description` prose:
   `"Only bed rails manufactured before December 15, 2025 are included in this
   recall. The manufacture date in YYYY-MM-DD format and model number are
   printed on the product packaging."` So `data/fetch.ts` maps `Description`
   into `code_info` and the predicate engine parses English sentences instead of
   a field. It works — the CPSC cases in `tests/predicates.test.ts` (26733,
   26096, 19059, 23022) all decide correctly — but it is parsing prose because
   the API has no place to put the data.

2. **`ProductUPCs` returns `[{ "UPC": "..." }]`, not strings.** The field name is
   plural and the obvious read is an array of barcodes. This cost real time: it
   surfaced as `TypeError: s.replace is not a function` inside our UPC
   normaliser, several hundred lines away from the cause. Fixed in
   `data/fetch.ts`; `src/match.ts` accepts both shapes because the frozen
   snapshot predates the fix.

3. **Exclusion clauses are nested inside inclusion clauses and only in prose.**
   `"Only drills with date codes 2017-37-FY through 2018-22-FY are affected. If
   the drill is marked with an \"X\" after the date code it has already been
   inspected and is not affected."` A range and an exception to it, in the same
   paragraph, with no structure. We surface the exception verbatim as a caveat
   and never let it clear a unit automatically, because getting that inference
   wrong is the dangerous direction.

4. **No `status` and no hazard-severity field.** FDA gives `status` (Ongoing /
   Terminated) and `classification` (Class I/II/III), which we use to rank
   results. CPSC gives neither, so consumer recalls cannot be ranked by whether
   they are still live.

5. **Two records ship a malformed `URL`.** `https:/www.cpsc.gov/...` with one
   slash, and `hhttps://www.cpsc.gov/...` with a doubled `h`. Every HouseCheck
   verdict promises a link to the primary source notice, so two of those links
   were dead. `safeUrl()` in `data/fetch.ts` and `src/match.ts` repairs the
   obvious typos and drops anything that is not http(s). A public dataset that
   nothing validates on the way out puts that check on every consumer.

6. **`RecallNumber` and `RecallID` are separate fields with no stated
   relationship.** Both are unique across the 2,480 records we pulled, but the
   docs do not say which is the stable key, so `data/fetch.ts` keys the internal
   id on `RecallID` and keeps `RecallNumber` for display.

**Would we build with it again.** Yes, for consumer goods there is no
alternative, and the remedy text and public URLs are better than FDA's. But
budget time for prose parsing: everything that makes a CPSC recall unit-specific
is in a paragraph, not a field.

---

## `node:sqlite`

**Used for.** The whole search index in `src/match.ts`: an in-memory FTS5 table
over product descriptions and a barcode lookup table, built from the frozen
snapshot at startup.

**Onboarding.** `import { DatabaseSync } from 'node:sqlite'` and you have a
database. No install, no native build step, no `better-sqlite3` compile against
the wrong Node ABI. For a hackathon entry that judges must be able to clone and
run, removing a native dependency is worth a lot on its own.

**What worked.**
- **FTS5 is compiled in.** We checked before designing around it (SQLite
  3.51.3), and `bm25()` ranking works. That was the one real risk in the plan
  and it evaporated.
- Building the index — 13,480 FTS rows plus roughly 90,000 barcode rows — takes
  about 350 ms. Fast enough that there is no build artifact to ship and no cache
  to invalidate.
- The synchronous API is the right call for this workload. No `await` noise
  around what is a memcpy.

**What needs work.**

1. **`ExperimentalWarning: SQLite is an experimental feature` prints on every
   run**, including inside `node --test`, where it lands in the middle of TAP
   output. Suppressing it needs `--no-warnings`, which suppresses everything
   else too. For a module that is in the docs and shipping in an LTS line, the
   warning is more alarming than the situation warrants.

2. **`.all()` returns null-prototype objects.** They are not plain objects:
   `Object.getPrototypeOf(row) === null`. Anything that walks a prototype chain
   behaves unexpectedly, and the TypeScript types resolve to a union that does
   not narrow, so every call site in `src/match.ts` needs an
   `as unknown as FtsRow[]` cast. That cast is exactly the kind of thing that
   hides a real type error later.

3. **No `pragma`-level feedback on which extensions are compiled in.** We had to
   probe by executing `create virtual table ... using fts5(...)` and catching
   the error. `spellfix1` is not available, which is why the fuzzy fallback in
   `src/match.ts` is three progressively looser FTS queries (AND, then OR, then
   prefix) rather than an edit-distance search.

4. **Errors from a malformed FTS5 MATCH expression are thrown, not returned.**
   User text becomes an FTS expression, so a stray quote is a crash unless every
   query is wrapped. `src/match.ts` catches and falls through to the next
   strategy.

**Would we build with it again.** Yes. Zero-install SQLite with FTS5 in the
standard library removes the single most annoying dependency in a Node project.
We would like the experimental warning gone and honest row objects.

---

## Node 22 native TypeScript and `node:test`

**Used for.** Everything. There is no build step, no `tsc`, no bundler, no
`package.json` in the project. `node src/match.ts` and `node --test` run the
`.ts` files directly.

**What worked.** Type stripping is invisible in normal use, and deleting a build
step from a project judges have to run is worth more than it sounds.

**What needs work.**

1. **`node --test tests/` fails with `Cannot find module .../tests`.** A bare
   `node --test` discovers the `.ts` test files correctly, and
   `node --test tests/*.test.ts` works, but passing the directory — the obvious
   thing to type — treats it as a module path. The error message says nothing
   about test discovery.

2. **Erasable syntax only.** No `enum`, no parameter properties, no `namespace`.
   Fine once known; the error arrives at runtime rather than from a linter.

3. **Import specifiers need the `.ts` extension** (`from './predicates.ts'`),
   which is correct for ESM and still surprises everyone.

4. **Stack traces point at the stripped source**, so column numbers in a line
   that had types removed are off by the width of the annotations. Readable, but
   not exact.

**Would we build with it again.** Yes. For a project that has to be cloned and
run by a stranger with no setup, "Node 22, no install, `node --test`" is the
strongest possible answer.

---

## MCP SDK (`@modelcontextprotocol/sdk` 1.30.0)

**Used for.** `src/mcp-server.ts`: an MCP server over the Streamable HTTP
transport at `POST /mcp`, exposing five tools that call the predicate engine.
Stateless mode (`sessionIdGenerator: undefined`) with `enableJsonResponse: true`,
served from a bare `node:http` server that also serves the web client, so there
is one process and one origin.

**What worked.**

1. **The version we needed is the default.** `LATEST_PROTOCOL_VERSION` in 1.30.0
   is `2025-11-25`, so `initialize` negotiates the required revision with no
   configuration. `SUPPORTED_PROTOCOL_VERSIONS` still lists four older revisions,
   so an older client is not shut out.

2. **`registerTool` is the whole API.** Name, title, description, a Zod shape for
   the input, annotations, handler. The JSON Schema that reaches `tools/list` is
   generated from the Zod shape, including the per-field `.describe()` text —
   which matters here, because an agent picks a tool and fills its arguments from
   nothing but those strings.

3. **Stateless mode is genuinely stateless.** A new `McpServer` and transport per
   request costs microseconds once the 13,480-notice index is a module-level
   singleton, and there is no session map to leak when a client walks away
   without sending `DELETE`.

**What needs work.**

1. **Installing the SDK broke the whole project, and the error pointed
   elsewhere.** Node 22 runs `.ts` directly, so before this step HouseCheck had
   no `package.json` at all. `npm init -y` writes `"type": "commonjs"`, and the
   next `node --test` went from 50 passing to 50 failing with module errors in
   files we had not touched. The fix is `"type": "module"`; nothing in the SDK
   docs warns that adding it to a zero-config Node project needs that line.

2. **`Accept` must list both media types, even when JSON responses are enabled.**
   With `enableJsonResponse: true` the transport still rejects a request whose
   `Accept` is only `application/json` — verified, both single values fail:

   ```
   accept: application/json                       -> -32000 Not Acceptable
   accept: text/event-stream                      -> -32000 Not Acceptable
   accept: application/json, text/event-stream    -> 200, JSON body
   ```

   The message is clear once you see it, but the natural first `curl` fails and
   the quickstart examples do not lead with the header.

3. **`structuredContent` is undocumented when there is no `outputSchema`.**
   Returning both a text summary (for an assistant to read aloud) and a rendered
   HTML card (for the web client) in one tool result is exactly what we needed,
   and it works — `validateToolOutput` returns early when a tool declares no
   output schema, so the field passes through untouched. We only know that
   because we read the compiled `dist/esm/server/mcp.js`. Declaring an
   `outputSchema` and finding out at runtime that structured content became
   mandatory is the alternative discovery path.

4. **The handshake is not enforced in stateless mode.** `tools/list` answers
   before any `initialize`. Convenient for `curl`, but it means a server cannot
   rely on the negotiated protocol version or client capabilities being set, and
   nothing in the type signatures hints at that.

5. **The transport handles POST only; the other verbs are yours.** Stateless mode
   has no stream to resume and no session to delete, so `GET` and `DELETE /mcp`
   are ours to answer. We return `405` with a JSON-RPC error body. Reasonable,
   but the examples all use an Express app that quietly makes this someone
   else\'s problem.

6. **Zod arrives as a transitive dependency.** `zod@4.5.4` comes in under the
   SDK, and `registerTool` wants a raw shape (`{ a: z.string() }`), not a
   `z.object(...)`. We added `zod` as a direct dependency rather than import a
   package we never installed.

**Onboarding.** From `npm i` to a server answering `tools/list` over Streamable
HTTP was about twenty minutes, and item 1 above was most of it. The type
definitions are good enough to work from directly, which is fortunate, because
the two behaviours that cost us time (items 2 and 3) are visible in the compiled
source and not in the README.

**Would we build with it again.** Yes. Streamable HTTP over stateless POST turned
out to be roughly forty lines of `node:http` on top of the SDK, with no
framework, and it made the browser client a `fetch` call rather than a transport
implementation. The one thing we would want up front is a page titled "what your
HTTP client must send", covering the `Accept` header, the handshake, and which
verbs the transport does not handle.
