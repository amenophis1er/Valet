# Releasing

A release is a version tag. Pushing `v0.1.1` runs `.github/workflows/release.yml`:
the CI checks, then `scripts/package.mjs` (the store package: a release build
without the manifest's `key`), an upload to the Chrome Web Store as the
listing's new draft, and a GitHub release holding the zip. Submitting the
draft for review is a separate step, off until the repository variable
`CWS_PUBLISH` is `true`; until then, review the draft in the developer
dashboard and press Publish there.

## Cutting a release

```sh
npm version 0.1.1 --no-git-tag-version   # package.json; the manifest takes it at build
git commit -am "0.1.1" && git push         # through a PR, like everything else
git tag v0.1.1 && git push origin v0.1.1   # once main holds the bump
```

The workflow refuses a tag that does not match `package.json`.

Run by hand (Actions → Release → Run workflow, or `gh workflow run release.yml`),
it uploads the current package as the listing's draft without a tag or a
GitHub release: the way to smoke-test the credentials, and to refresh the
draft between versions.

The listing's text and images are not part of this: the description, the
screenshots and the promo tiles are edited in the dashboard (local copies in
`store/`, which is kept out of git).

## One-time setup: the store credentials

The upload uses the Chrome Web Store API with an OAuth refresh token of the
developer account. Four repository secrets:

| Secret | What |
| --- | --- |
| `CWS_EXTENSION_ID` | The item's id, from its dashboard URL (`…/devconsole/…/<id>`). |
| `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET` | An OAuth client of your own Google Cloud project. |
| `CWS_REFRESH_TOKEN` | A refresh token for that client with the `chromewebstore` scope. |

1. In [Google Cloud](https://console.cloud.google.com/) create a project (or
   pick one), enable the **Chrome Web Store API** (APIs & Services → Library),
   and under **OAuth consent screen** set it up as *External* with yourself as
   a test user (it never needs verification: only you use it).
2. **Credentials → Create credentials → OAuth client ID**, type **Web
   application**, with `http://localhost:8080` as an authorized redirect URI.
   Keep the client id and secret.
3. Mint the refresh token, in your own terminal (it is shown once, and goes
   straight into the secret):

   ```sh
   CLIENT_ID=… CLIENT_SECRET=… node scripts/cws-token.mjs
   ```

   It prints a consent URL: open it in the browser where the developer account
   is signed in, approve, and the token appears in the terminal. It does not
   expire while it is used; a consent screen left in *Testing* expires tokens
   after 7 days, so set it to *In production* once it works (no verification
   is needed when only you use it).
4. Set the four secrets: `gh secret set CWS_EXTENSION_ID` and so on, each
   prompting for the value, or Settings → Secrets and variables → Actions.
5. Try it from your machine first, which checks the credentials without a tag:

   ```sh
   node scripts/package.mjs release
   EXTENSION_ID=… CLIENT_ID=… CLIENT_SECRET=… REFRESH_TOKEN=… \
     npx chrome-webstore-upload-cli@3 upload --source release/valet-<version>.zip
   ```

   This replaces the listing's draft package (nothing is published).

When a release should go straight to review: `gh variable set CWS_PUBLISH --body true`.
