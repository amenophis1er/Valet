# Contributing

Errand is small and moves fast; issues and pull requests are welcome.

## Running it

```sh
npm install
npm run dev        # builds dist/ and rebuilds on change; load dist/ unpacked
npm run typecheck
npm test           # unit tests (vitest)
npm run e2e        # Chromium end to end (playwright)
npm run screenshots # every screen and state, light and dark, into screenshots/
```

Load `dist/` at chrome://extensions with Developer mode on. In dev builds the
extension reloads itself when the worker changes and the panel reloads when
only panel files change.

## Pull requests

- Keep a PR to one change, with tests for what it changes. CI runs typecheck,
  unit tests, the build and the e2e suite.
- Anything that touches what a page or a model can make the extension do —
  the controller, containment, approvals, screenshot masking — needs a test
  that shows the page or model failing to do it.
- No new permissions without a line in the README saying why.

## Security

For anything that lets a page or a model act outside the owner's task, see
[SECURITY.md](SECURITY.md) and report privately rather than opening an issue.
