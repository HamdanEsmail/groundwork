# Groundwork: the look

The reference is `design/comp-home.html` and `design/comp-dossier.html` (pictures: `design/look-*.jpg`). The
stylesheets `public/assets/site.css` and `public/assets/dossier.css` are those pages' own CSS. Where this file
and a comp disagree, the comp wins for the screen it shows and this file wins for every other screen.

## The idea

In 1866 Ernest Hexamer began surveying Philadelphia's buildings one plate per property: a coloured plan, the
streets around it, and a written description of walls, roofs and boilers. Groundwork is the same kind of sheet,
read today from the city's own pages. The home is a contact sheet of those plates and of city pages as they were
read, and the address form is one cell of the sheet. A dossier is a set of nine sheets, one per office.

## Colour

| Token | Value | Use |
|---|---|---|
| `--sheet` | `#f4f5f2` | the page |
| `--panel` | `#ffffff` | a sheet, the figures band |
| `--panel-2` | `#eceee9` | every other row, tracks, quiet tiles |
| `--ink` | `#1f262e` | text, the dark tile, the main button |
| `--ink-2` | `#4a5560` | secondary text, never smaller than 13px |
| `--blue` | `#35537a` | the drafting ink: the text cell, the title of a dossier, links, the current sheet |
| `--blue-deep` | `#263d5c` | a pressed or hovered blue, quiet buttons on blue |
| `--blue-wash` | `#e7edf4` | the sheets not read yet, a hovered row |
| `--blue-line` | `#b9c6d6` | the lines inside a table, nowhere else |
| `--on-blue` | `#dbe4ef` | secondary text on blue |
| `--ok` `--warn` `--bad` | `#3f6b4f` `#8a5d16` `#8c2f2f` | the square beside a status word; `--bad` also for the word "open" |
| `--plate` | `#f3e3c3` | behind a plate while it loads |

A section is one flat field of one of these. No gradients, no shadows, no rounded corners. A status is always
said in words; the coloured square only repeats it.

## Type

**Archivo** 400, 500, 600 for everything read as language. **JetBrains Mono** 400, 500 only for what is copied
or compared character by character: account numbers, permit and case numbers, dates in tables, amounts, the
address field. Both from Google Fonts' stylesheet.

| Step | Size | Use |
|---|---|---|
| small | 13px | strips, labels of facts, table headings, notes |
| table | 15 to 16px | records, source lines |
| body | 17 to 18px | running text, facts |
| lead | 21px | the sentence in the text cell, sub-headings of a sheet |
| head | 28 to 32px | section and sheet headings |
| display | up to 9vw | the address of a dossier, the wordmark in the footer, "Nine offices" |

A headline is never more than two lines at any width.

## The parts

- **Frame and strip.** A picture cropped to a fixed ratio with a 30px strip fused under it that names it. Strip
  colours rotate through blue, wash, ink and pale.
- **The text cell.** The one cell of the sheet that is not a picture: blue, with the wordmark, one sentence, the
  address field, three examples and three links. On a phone it comes first, full width.
- **The board.** One plate seen through a grid of tiles, with flat tiles for a heading, three facts and one link.
- **The run-in column.** One column of paragraphs that open with a bold phrase, each followed by a small piece of
  the product itself.
- **The title of a dossier.** The street address in capitals at display size on blue, the city under it, the
  actions to the right, and four facts in a row: account, read time, sheets read, cost.
- **The figures.** Five numbers in mono with a sentence under each.
- **The record by date.** One lane per kind of record on a ruler from the year built to now. A mark is a
  button; pointing at it or focusing it writes the record into the dark line below.
- **A sheet.** Number, heading, status word, the office and read time with the source link, facts, tables,
  then the page as it was read. A sheet that could not be read keeps its place and says why, with the link to
  check by hand. Sheets that were not asked for are listed together on one washed sheet with what each adds and
  what it costs.
- **The index.** The nine sheets with their status words, beside the sheets; it marks the one in view.

## Voice

Factual, present tense, units always. Dates as "17 Sep 1993"; read times as "9 Nov 2026, 17:34 UTC". A count of
rows shown is never presented as the count on file: "5 of 155 shown", "4 open among the latest 4 shown; 83 on
file". Offices are named, not URLs. No exclamation marks, no opinion, no valuation. On every dossier: "A report
of what the official pages say, not a valuation and not advice."

## Pictures

Nine plates from the Hexamer General Surveys (1866 to 1880), public domain, credited in the footer and in full
on the about page from `design/credits.json`. Six captures of city pages as they were read. A plate shows the
world this work belongs to; it is never presented as a picture of the address in a dossier. An evidence
screenshot is shown only when it holds the page: a blank capture is not evidence.

## Motion

Parts of a section rise 24px as they enter, 70ms apart. The board opens once from its top edge and its plate
drifts slowly. Controls answer a press. Everything holds still under `prefers-reduced-motion`, and nothing is
hidden when scripts do not run.

## Never

Gradients, shadows, rounded corners, outlined cards, icons, emoji, a third typeface, text under 13px, numbered
steps, a status by colour alone, a figure that is not on an official page.
