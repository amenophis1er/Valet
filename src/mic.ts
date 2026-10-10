/*
 * mic.html: asks Chrome for the microphone once, in a tab, because the side
 * panel cannot show the prompt. The stream is closed at once; dictation in the
 * panel then works with the permission the extension now has.
 */

const status = document.getElementById('status')!;

try {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of stream.getTracks()) track.stop();
  status.textContent = 'Done: the microphone is allowed. Close this tab and press the mic in the side panel again.';
} catch (error) {
  const denied = error instanceof DOMException && error.name === 'NotAllowedError';
  status.textContent = denied
    ? 'The microphone was blocked. To use dictation, allow it for Errand in Chrome’s site settings (the icon at the left of the address bar), then reload this tab.'
    : `The microphone could not be opened: ${error instanceof Error ? error.message : String(error)}`;
}
