# Demo video — shot list

**Length 2:40 of a 3:00 limit. Screen recording only. No voice-over: every shot
is captioned on screen, so the video reads with the sound off.**

The spine is one movement, repeated once with a single character changed:

> Same eggs. Same barcode. One carton is under a Class I *Salmonella* recall.
> The other is not. The only difference is three digits stamped on the side.

Nothing else earns time. No architecture diagram, no logo animation, no tour of
the repo.

---

## Setup before recording

```bash
npm install
npm run serve        # http://127.0.0.1:8765
```

Second terminal ready with `npm test` typed but not run. Browser at
<http://127.0.0.1:8765/>, window at 1280x800, page zoom 125% so the card text is
legible at 720p. System appearance either mode — the card renders both. Clear the
transcript with a reload before the take.

Caption style: bottom third, one line, sentence case, no bullet points, held long
enough to read at a glance. Cuts are hard cuts. No music, or something flat and
quiet under the whole thing.

---

## 0:00 — 0:14   The problem, in the source's own words

**Shot.** Full-screen text on a plain background: the real `code_info` string,
typed out, with `157 and 184` highlighted as it lands.

```
Codes P-1950 or 0840962 with a Julian Date between 157 and 184
and a Best By/Sell By date Between July 20 - August 17, 2026
```

**Caption.** `FDA recall H-1230-2026. Class I. Still ongoing.`
Then: `A search engine can find this notice. It cannot tell you if your carton is in it.`

---

## 0:14 — 0:22   The client

**Shot.** Cut to the browser. Empty HouseCheck transcript. Cursor in the field.
The header reads `MCP 2025-11-25 · housecheck · 5 tools` — do not zoom to it, but
do not crop it out either.

**Caption.** `HouseCheck. It answers the other question.`

---

## 0:22 — 0:44   Lane one — the affected carton

**Shot.** Type the barcode off the carton and send.

```
0 11110-60902 1
```

The card lands: **NEED A CODE**, amber. Scroll it slowly, once, so the three
unresolved rows are visible — `Lot code`, `Julian date code`, `Best-by date`,
each `not supplied · unresolved` — and stop on the question:

> What is the lot or batch code printed on the package? (printed on the left or
> right sides of the carton.)

**Caption at the top of the card.** `It found the recall — and refuses to guess.`
**Caption on the question.** `The location hint is the notice's own wording.`

---

## 0:44 — 1:10   Answering the questions

**Shot.** Three exchanges, no cuts between them, at typing speed.

| type | card comes back |
|---|---|
| `P-1950` | still **NEED A CODE** — lot now `in scope`, two rows to go |
| `173` | still **NEED A CODE** — julian now `in scope`, one row to go |
| `August 1 2026` | **AFFECTED**, red |

**Caption during the first two.** `One code at a time. Still not enough to decide.`
**Caption as the verdict flips.** `Now it can decide.`

Hold on the AFFECTED card. Let the rule table be readable: three rows, three
`in scope`, each with the fragment of the notice it was read from.

---

## 1:10 — 1:24   What an affected owner gets

**Shot.** Scroll down the AFFECTED card at reading speed, through:

- `CODE INFORMATION ON THE NOTICE, VERBATIM` — the raw sentence from 0:00
- `REASON FOR THE RECALL, VERBATIM` — *Possible Salmonella Enteritidis*
- `Primary source notice` — hover the link so the URL shows in the status bar

**Caption.** `Every verdict shows the exact text it reasoned over, and links the
source.`

---

## 1:24 — 1:52   **Lane two — the whole point**

**Shot.** Reload. Same barcode, same lot, then **one character group changed**.

```
0 11110-60902 1
P-1950
200                 <- was 173
September 1 2026
```

The card comes back **NOT AFFECTED**, green.

Cut to a **side-by-side freeze**: the AFFECTED card from 1:10 on the left, this
NOT AFFECTED card on the right, both scrolled to the rule table. The `Lot code`
row is identical on both. The `Julian date code` row reads `173 · in scope` on
the left and `200 · outside scope` on the right.

**Caption, held for four seconds — this is the shot the judges remember.**

```
Same product. Same barcode. Same lot code.
One number different — and the answer is different.
```

---

## 1:52 — 2:10   Under the hood, briefly

**Shot.** Terminal, split or cut, two commands.

```bash
npm test
# tests 55   pass 55   fail 0
```

then

```bash
node src/match.ts --upc="0 11110-60902 1" --lot=P-1950 --julian=173 --best_by=2026-08-01
```

showing `AFFECTED` with the three `[YES]` clause lines.

**Caption.** `The predicate engine is 55 assertions over real frozen notices.
Plain node --test, no framework.`
Then: `13,480 notices committed to the repo. No network at runtime. No API key.`

---

## 2:10 — 2:26   The MCP surface

**Shot.** Terminal. Paste and run:

```bash
curl -s -X POST http://127.0.0.1:8765/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq -r '.result.tools[].name'
```

Output, five lines:

```
check_recall
search_product
explain_verdict
get_remedy
list_recent_recalls
```

**Caption.** `An MCP server over Streamable HTTP, spec 2025-11-25. The client in
this video is one of its callers.`

---

## 2:26 — 2:40   The honest close

**Shot.** Back to the browser, on the NOT AFFECTED card. Then a final full-screen
caption on a plain background:

```
NOT AFFECTED is the only verdict that has to be proven.
When the notice is truncated, redacted or ambiguous,
HouseCheck asks — it never clears a unit on a guess.
```

Hold three seconds. Cut to black on the repo URL alone.

---

## Rules for the edit

- **Never cut away mid-verdict.** The verdict badge changing is the whole story;
  every cut lands between exchanges, never inside one.
- **Never speed-ramp the typing.** A code being typed in real time is what sells
  that the tool is deciding rather than looking up.
- **Do not narrate what is on screen.** The captions carry only what the picture
  cannot: why it matters.
- **No Amazon or Alexa marks, no third-party logos, no stock photography, no
  music with a licence question.** Only this repo's own UI and terminal output.
- **Do not stage the data.** The eggs recall on screen is real, live, Class I and
  unmodified. Say the recall number on the first caption so it can be checked.
