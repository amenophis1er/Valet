/* How the agent's mouse and keys move: along a gentle curve, a beat between steps. */

import type { Driver, Point, Send } from '../driver.js';

/** A few points on a gentle curve from the mouse's last place in this tab to the target. */
export function path(driver: Driver, tabId: number, to: Point): Point[] {
  const from = driver.mouse.get(tabId) ?? { x: Math.max(0, to.x - 160), y: to.y + 120 };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const bend = (driver.random() - 0.5) * 0.3;
  const control = { x: from.x + dx / 2 - dy * bend, y: from.y + dy / 2 + dx * bend };
  const steps = 8;
  const points: Point[] = [];
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    // Eased, so it starts and ends slower.
    const e = t * t * (3 - 2 * t);
    points.push({
      x: Math.round((1 - e) ** 2 * from.x + 2 * (1 - e) * e * control.x + e ** 2 * to.x),
      y: Math.round((1 - e) ** 2 * from.y + 2 * (1 - e) * e * control.y + e ** 2 * to.y),
    });
  }
  return points;
}

/** The mouse along that curve, with the buttons held as given; a beat between steps so the page sees motion. */
export async function glide(driver: Driver, send: Send, tabId: number, to: Point, buttons: 0 | 1): Promise<void> {
  for (const step of path(driver, tabId, to)) {
    await send('Input.dispatchMouseEvent', { x: step.x, y: step.y, type: 'mouseMoved', button: buttons ? 'left' : 'none', buttons });
    await driver.wait(driver.pace === 'natural' ? 12 + Math.round(14 * driver.random()) : 8);
  }
}

/** One character as a key press: Enter for a line break, the character's own key otherwise. */
export async function typeKey(send: Send, character: string): Promise<void> {
  if (character === '\n') {
    const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await send('Input.dispatchKeyEvent', { ...enter, type: 'keyDown', text: '\r' });
    await send('Input.dispatchKeyEvent', { ...enter, type: 'keyUp' });
    return;
  }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: character, text: character, unmodifiedText: character });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
}

/** The mouse cannot be aimed into a frame from another site: its place in the viewport cannot be read. */
export const OTHER_SITE_FRAME = 'That element is inside a frame from another site, where the mouse cannot be aimed. Use a ref in the page itself.';
