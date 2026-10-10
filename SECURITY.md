# Security

This extension holds your AI provider credentials and can drive web pages
with the `debugger` permission, so security reports are welcome and taken
seriously. The safety model is summarized in the [README](README.md#safety-model).

## Reporting a vulnerability

Please report privately through GitHub's
[private vulnerability reporting](https://github.com/amenophis1er/errand/security/advisories/new)
rather than a public issue. Include what an attacker controls (a web page,
another extension, the model's output) and what they gain.

Especially in scope:

- a page steering the agent to an origin the owner did not approve, or
  submitting a form without an approval (run scope, containment, approvals);
- provider keys or device keys leaving the background worker;
- the agent acting in a tab the owner did not hand it, or in a handed tab
  after it was released;
- pixels or text from a site outside the run reaching the model (screenshot
  masking, frame redaction).

## Supported versions

Only the latest commit on `main` is supported while the project is pre-1.0.
