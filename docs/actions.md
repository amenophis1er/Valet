# Actions

<!-- Generated from src/actions by `npm run docs`. Do not edit by hand: reference.test.ts fails when this file and the code disagree. -->

The agent works through one tool, `browser`. Each call names an `action` and the fields it needs.
Every call is validated, then checked by the run controller (fresh evidence, the run's scope, form submissions) before anything is dispatched; see [architecture.md](architecture.md).

**Acting actions** — `click`, `hover`, `drag`, `fill`, `select`, `press`, `scroll` — act on the page: they must carry the latest `observation` id, invalidate it, and are followed by a new observation.

## Summary

| Action | Acts on the page | Required | Optional | Safety facts |
| --- | --- | --- | --- | --- |
| `navigate` | no | `url` | `newTab` | goes to a URL (scope-checked) |
| `observe` | no | — | — | — |
| `read` | no | — | `part` | — |
| `screenshot` | no | — | — | — |
| `click` | yes | — | `target`, `point`, `screenshot`, `count`, `button` | may follow a link (scope-checked); may submit a form (owner approves) |
| `hover` | yes | — | `target`, `point`, `screenshot` | — |
| `drag` | yes | — | `target`, `point`, `screenshot`, `to` | — |
| `fill` | yes | `target`, `value` | — | — |
| `select` | yes | `target`, `value` | — | — |
| `press` | yes | `key`, `target` | — | may submit a form (owner approves) |
| `scroll` | yes | `direction` | — | — |
| `tab` | no | `tabId` | — | — |
| `close` | no | — | — | — |

## Each action

### `navigate`

Start with {action:"navigate",url:"https://..."}: it goes there in the tab you are working in. With newTab:true it opens the url in a new tab of this conversation instead and works there from then on; use it to keep the page you are on, or when the owner asks for another tab. Every result carries a fresh observation: id, url, title, an aria-style tree, targets with refs like e12, and the tabs of this conversation.

### `observe`

observe reads the page again: a fresh observation with new refs, when the page may have changed on its own.

### `read`

read gives you the text of the current page — its main content, headings, lists and tables, without menus or refs — in parts of a few thousand words. Use it whenever the content is the task (summarize, answer from, quote or extract a page): an observation is cut to fit and is for acting, not reading. A result says which part it is and how many there are; read the next part until you have what the task needs before you answer. On a very long page the oldest parts drop out of view: note the key facts in a line as you go, and do not read a part twice.

### `screenshot`

screenshot shows you the visible part of the current tab as an image, and shows it to the owner too; use it when layout, images or charts matter, not instead of observe. Parts of the page from sites outside this run are painted grey.

### `click`

Prefer {action:"click",observation:"COPY_LATEST_ID",target:{ref:"e12"}}; copy actual refs, never invent them. Semantic links use by:"role",role:"link",name:"...". click takes count:2 for a double-click — the way many apps open an item in a list (files in Drive, rows in a table) — and button:"right" for a context menu. A menu item that opens a submenu: hover it, observe, then click the item in the submenu. When a screenshot shows something the observation cannot name (a canvas, a map, a chart, a custom control), click it by point: {action:"click",observation:"COPY_LATEST_ID",screenshot:"COPY_SCREENSHOT_ID",point:{x,y}} in the image's pixels. Refs are exact; points are for what has no ref. A grey area cannot be clicked.

### `hover`

hover moves the mouse onto a target or point without clicking (menus that open on hover, tooltips).

### `drag`

drag presses on a target or point and releases on `to` (a target or point): sliders, maps, reordering, drawing.

### `fill`

fill replaces the value of a non-password text field.

### `select`

select picks an option by its label, text or value.

### `press`

press sends a listed key to a target.

### `scroll`

scroll moves the page up or down.

### `tab`

tab switches to a tabId from observation.tabs. A link that opens a new tab opens one of yours: observe then reads it.

### `close`

close closes this conversation's tabs.

## Fields

| Field | Type | Description |
| --- | --- | --- |
| `url` | `string` | Required for navigate. http or https only. |
| `newTab` | `boolean` | navigate only: open the url in a new tab of this conversation and work there, leaving the current tab as it is. Refused on any other action. |
| `target` | `object` | Required for fill, select and press; click, hover and drag take a target or a point. Prefer a ref copied from the latest observation.targets. |
| `point` | `object` | click, hover and drag, instead of a target: a point on the latest screenshot, in that image's pixels (x from the left, y from the top). For what the observation cannot name — a canvas, a map, a chart, a custom control. Needs screenshot. Refused on any other action. |
| `count` | `integer` | click only: 2 for a double-click (open a file in a list, select a word). Default 1. Refused on any other action. |
| `button` | `left` \| `right` | click only: "right" opens the context menu (then click an item in it). Default left. Refused on any other action. |
| `to` | `object` | Required for drag: where the drag ends — a target (a ref) or a point on the latest screenshot. Refused on any other action. |
| `screenshot` | `string` | Required with point: copy screenshot.id from the latest screenshot result. A screenshot taken before any action is stale. |
| `value` | `string` | Required for fill (the text) and select (an option label, text or value). |
| `key` | `Enter` \| `Tab` \| `Escape` \| `ArrowDown` \| `ArrowUp` \| `ArrowLeft` \| `ArrowRight` \| `Space` \| `Backspace` | Required for press, with a target. |
| `direction` | `up` \| `down` | Required for scroll. |
| `part` | `integer` | read only: which part of a long page's text, from 1. Default 1; a result says how many parts there are. Refused on any other action. |
| `tabId` | `string` | Required for tab: an id from observation.tabs. |
| `observation` | `string` | REQUIRED for click, hover, drag, fill, select, press and scroll. Copy observation.id from the most recent result, including recovery results. Never reuse after a dispatched action. |
