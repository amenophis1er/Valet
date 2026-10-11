# Valet privacy policy

*Last updated: October 10, 2026*

Valet is a Chrome extension: an AI agent that works in your browser with an AI
model you connect yourself. It is open source; this policy describes what the
code in this repository does.

## The short version

There is no Valet server and no Valet account. The developer receives nothing:
no page content, no conversations, no keys, no analytics, no crash reports.
What Valet reads to do a task goes only to the AI provider you chose.

## What Valet handles, and where it goes

**Pages you ask it to work on.** To do a task, Valet reads the page in the tab
it works in — its text, the names of its elements, its address and title — and,
when it needs to, takes a screenshot of it. This goes to the AI provider of the
connection you picked (for example Anthropic, OpenAI, OpenRouter, Ollama, or a
server you named), and nowhere else. Parts of a page that come from sites you
have not allowed are painted grey before a screenshot is sent. With a model
running on your own computer (such as Ollama), nothing leaves it.

**What you type, attach or dictate.** Your messages and any images, PDFs or
text files you attach go to that same provider, as part of the conversation.
Dictation uses Chrome's own speech recognition: on your device when Chrome
supports it, otherwise Chrome's speech service (operated by Google). The
punctuation cleanup after dictation runs only on your device, with Chrome's
built-in model, or not at all.

**Your connections.** API keys and sign-in tokens for the providers you connect
are stored encrypted in the extension's storage on your device, and are sent
only to the provider they belong to, to authenticate your own requests.

**Conversations.** Conversation state, attachments and run traces live in
Chrome's session storage and are cleared when the browser closes. A run trace
leaves your computer only if you save it and share the file yourself.

**Settings and skills.** Your settings (pace, Ask/Auto) are kept in the
extension's local storage. Skills — short notes you write for the agent — are
kept in Chrome's sync storage, so they follow your Chrome profile through
Google's sync if you have it on. They contain what you wrote, never page
content or conversation history.

**Files it makes.** Reports and files the agent writes stay in the extension
until you click Download.

## What Valet does not do

- It does not send anything to the developer or to any server of this project.
- It does not use analytics, advertising, tracking or telemetry.
- It does not sell or transfer your data, or use it for anything but the task
  you gave it.
- It does not read pages in the background: it works only in the tabs of a
  task you started, and asks before it opens a site you have not allowed or
  submits a form.

## Third parties

Your AI provider receives the content described above under its own terms and
privacy policy, which you accepted when you created your account or key with
it. Valet has no agreement with any provider and shares nothing with them
beyond your own requests.

## Your control

Remove a connection in Settings to delete its key or sign-in. Delete skills in
Settings → Skills. Closing the browser clears conversations. Uninstalling Valet
removes everything it stored.

## Changes and contact

Changes to this policy are made in this file, with the history in this
repository. Questions: open an issue at
https://github.com/amenophis1er/Valet/issues.
