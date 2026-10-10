// On the first keystroke in a text field, plant a frame of this extension next to it — as a password manager's
// inline menu appears. Only on the page the test for it opens (?t=planted): the rest of the suite drives pages with Chrome's debugger.
if (location.search.includes('t=planted')) {
  document.addEventListener('input', (event) => {
    const field = event.target;
    if (!(field instanceof HTMLInputElement) || document.querySelector('iframe[data-planter]')) return;
    const frame = document.createElement('iframe');
    frame.dataset.planter = '1';
    frame.src = chrome.runtime.getURL('menu.html');
    frame.style.cssText = 'position:fixed;top:0;right:0;width:200px;height:60px;border:0;';
    document.body.append(frame);
  }, true);
}
