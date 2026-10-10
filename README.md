# Valet

**An AI agent that works in your own Chrome, with the model you bring.**

Open the side panel on any page, say what you want done, and it does it right
there: it reads the page, clicks, types, follows links and fills forms while
you watch. Everything runs inside the extension — no server, no account, no
companion app.

- **Your tab is the workspace.** The agent works in the page you're on, shown
  with a glowing border and its own "Valet" cursor, and follow-up messages
  continue in the same tab. Watch it work in any of its tabs; Stop hands them
  back at once. Tabs it opens for itself go right next to yours, in one
  `valet` tab group with it, until they close.
- **One conversation per tab.** The panel belongs to the tab you open it on:
  it shows there, and on the tabs its agent opens, and nowhere else. Open it
  on another tab for a second task with a conversation of its own. Closing a
  tab ends its conversation; the agent's tabs stay open.
- **It asks before it matters.** A new site and every form submission need
  your **Allow once / Allow in chat / Deny** — or switch to **Auto** to approve
  sites without cards; searches and filters go through too, while a form that
  sends data still asks. Approvals are not remembered after
  the conversation; only the Ask/Auto choice carries over.
- **Any model.** Sign in with your **Claude Pro/Max** or **ChatGPT
  Plus/Pro** subscription, or use an API key for Anthropic, OpenAI or
  OpenRouter, Ollama Cloud (sign in, no key), Ollama on your machine, or any
  OpenAI-compatible server. Keys and sign-ins stay encrypted in the extension.

> **Status:** early and unpacked-only. It works day to day, but expect rough
> edges, and install it from source (below).

## What it can do

- **Drive pages** — click, hover, drag, type, choose options, press keys,
  scroll, switch and close its own tabs. Input is real browser input (through Chrome's
  debugger), so it works on pages that ignore scripted events.
- **See the page** — as an accessibility tree with a ref for every element,
  and, when layout or images matter, as a **screenshot** it can take itself.
  Parts of a page that come from sites you haven't allowed are painted grey
  before any pixel reaches the model. What the tree cannot name — a canvas, a
  map, a chart, a custom control — it can **click by point** on that
  screenshot; refs stay the first choice, and a grey area cannot be clicked.
- **Make files for you** — a summary as `.md`, a table as `.csv`, data as
  `.json`, a document as `.pdf` (Chrome itself prints it, in a tab that opens
  and closes again). You get a Download button; nothing is saved until you click.
- **Take what you give it** — attach images, PDFs and text files (pick, drag
  in, or paste), or a screenshot of any tab, window or screen through Chrome's
  own share dialog. Or dictate with the mic.
- **Work at your pace** — *Fast* does each action at once; *Natural* types
  letter by letter, moves the mouse smoothly and pauses between steps, so you
  can follow along (Settings → Pace).
- **Learn** — a toggle in the message box: one step at a time. Before each
  action the agent points at where it will go, says in a bubble what it will
  do and why, and waits for you to press Next — in the bubble or in the panel.
- **Learn your ways** — write a **skill**: a short note it reads on the sites
  you name ("archive means the Archive button, not Delete") or on every task.
  Type `@` in the message box to bring one in, and after a run that went well,
  **Save as skill** drafts one from what worked — you edit it before it is
  kept (Settings → Skills).

- **See why a run went wrong** — the ⋯ menu saves a **run trace**: every
  model turn, every action with its arguments and result, every approval and
  state change, with times — one JSON file to inspect or share.

## Safety model

The model reads untrusted web pages, so the extension — not the model —
enforces the rules:

- **Approvals last one conversation.** A request starts allowed only on the
  page you handed it. Any other site asks: *Allow once* (this request) or
  *Allow in chat* (until New conversation). Navigation to sites you haven't
  allowed — redirects included — is blocked before it leaves the browser.
- **Auto** approves every site without a card for the conversation, and the
  next conversation starts in it (with a visible chip that turns it off). Form
  submissions still ask in Auto.
- **Form submissions** show where the data goes and what the agent filled in,
  and are re-checked right before sending: if anything changed, you're asked
  again. A submission whose outcome is uncertain is never repeated.
- **Evidence rules.** Every action names an element from the latest
  observation; if the page changed underneath, the action is refused before
  anything is dispatched.
- **Hard limits.** The agent never types into password fields, never runs
  code in pages, and never follows instructions found in page content. Sign-ins,
  CAPTCHAs and MFA are handed to you.
- **Budgets.** At most 40 browser actions and 20 minutes per run; Stop always
  works.

## Privacy

Page content, screenshots and attachments go only to the provider of the
connection you picked — nowhere else, and never to a server of this project
(there isn't one). With Ollama on your machine, nothing leaves it.
Conversation state lives in Chrome's session storage and is cleared when the
browser closes. Skills are the one thing kept: your own notes, in Chrome's
sync storage (so they follow your profile), exportable as JSON — never page
content or conversation history. Dictation uses Chrome's speech recognition: on your device
when Chrome supports it, otherwise Chrome's speech service (the mic's tooltip
says which).

## Install from source

On first install Valet opens a welcome page: open the side panel, connect a
model, try a first task. It is there again under Settings → Welcome guide.

Requirements: Chrome 116+ and Node 22+.

```sh
git clone https://github.com/amenophis1er/Valet.git
cd Valet
npm install
npm run build
```

Then open `chrome://extensions`, turn on **Developer mode**, click **Load
unpacked** and pick the `dist/` folder. Click the toolbar icon to open the side
panel, open **Settings** (the gear), add a connection and pick a model.

Chrome shows a "started debugging this browser" bar while the agent acts:
that's the debugger it uses for real input.

## Development

```sh
npm run dev          # rebuild on save; the loaded extension reloads itself
npm test             # unit tests (Vitest)
npm run e2e          # end to end in Chromium (Playwright)
npm run typecheck
npm run lint         # Biome, and the layering rules in .dependency-cruiser.cjs
npm run docs         # regenerate docs/actions.md from the action registry
```

How it is put together — the layers, the path every action takes, what the
extension guarantees — is in [docs/architecture.md](docs/architecture.md);
every action and field is in [docs/actions.md](docs/actions.md).

`npm run dev` builds with inline source maps and watches `src/` and `static/`.
A change to the panel's files reloads the open panel in place; a change to the
worker, the content script or the manifest reloads the extension, which closes
its panels (click the icon again). Each part compares what is on disk with the
build it came from, so a change made while the worker was asleep is picked up
the moment it wakes. What is typed in the composer is kept until it is sent.
To work on the model library at the same time, link your checkout and the
watcher follows its build: `npm install --no-save ../byok`.

| Where | What |
| --- | --- |
| `src/background.ts` | The service worker: wires everything together |
| `src/loop/` | The agent loop, the system prompt, attachments and files |
| `src/actions/` | The browser tool's contract: one spec per action; the validator, schema and description are built from it |
| `src/controller/` | Between the model and the browser: evidence, scope, form approvals, failure classes |
| `src/executor/` | Chrome itself: tabs, observation, screenshots, the debugger |
| `src/executor/input/` | One file per input action (click, drag, fill…), behind a narrow driver |
| `src/scope/` | Which sites a run may reach, and network-level containment |
| `src/panel.ts`, `static/` | The side panel |
| `src/dictation/` | The mic: speech to text with punctuation cleanup, self-contained ([README](src/dictation/README.md)) |

Model connectivity comes from
[byok](https://github.com/amenophis1er/byok),
a small library for bring-your-own-key AI in extensions.

## Limitations

- Chrome (and Chromium browsers) only, loaded unpacked; no store listing yet.
- Canvas-only apps (some maps, editors, games) work only through screenshots
  and clicks, hovers and drags by point, which need a model that can see
  images and place a point well.
- Smaller local models may struggle with tool calling; a stronger model helps.

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE).
