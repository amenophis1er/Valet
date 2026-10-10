# Dictation

Speech to text for a text field in a Chrome extension page. Words appear as they are spoken. Once the speaker stops, the dictated text is tidied: sentence casing and end punctuation from simple rules, then the punctuation inside sentences from Chrome's on-device model when the device has it.

This folder imports nothing from the rest of Valet, and a layering rule keeps it that way. To use it elsewhere, copy the folder.

```ts
import { dictation } from './dictation/index.js';

const mic = dictation(textarea, {
  onInput: () => resize(textarea),
  onListening: (on) => button.setAttribute('aria-pressed', String(on)),
  onEnd: (error) => { if (error === 'not-allowed') askForTheMicrophone(); },
});
button.hidden = !mic.supported();
button.title = mic.describe();
button.onclick = () => mic.toggle();
```

## Parts

| File | What it does |
| --- | --- |
| `recognizer.ts` | Chrome's speech recognition: settled text and the current guess, on the device when it can. |
| `polish.ts` | Pure text rules: `settle` fixes casing as a phrase settles, `finish` adds the end period or question mark, `sameWords` checks that a cleanup changed no word. |
| `proofread.ts` | The on-device cleanup: Chrome's Proofreader API, else its Prompt API. It only uses a model that is already on the device, and throws away any answer that changed a word. |
| `field.ts` | Binds it all to a field: the live text, then the end pass. |
| `index.ts` | `dictation(field, options)` with Chrome's parts, plus every part on its own. |

## What the end pass may change

- **Only the dictated stretch.** It never touches text that was in the field before dictation began.
- **Only if that stretch is unchanged.** If the owner edited or sent it by the time a cleanup is ready, nothing is replaced.
- **Only punctuation and casing.** An answer with any word added, removed or changed is discarded.
- **Through the browser's own editing** when the field has focus, so Cmd+Z brings the raw words back.

## Limits

- The rules cover languages written in Latin script. Questions are detected in English only.
- Chrome finalizes speech at pauses, not at sentence ends, so the live text gets casing but no periods.
- An extension's side panel cannot show the microphone prompt. The first `start()` ends with `not-allowed`, and the host page must ask from a tab, as Valet's `mic.html` does.
