/**
 * @vitest-environment jsdom
 *
 * The page-side stand-ins for real input, used inside subframes and when
 * another extension's frame keeps the debugger out.
 */
import { describe, expect, it, vi } from 'vitest';
import { pressRef } from './commands.js';

function registry(element: Element): void {
  (globalThis as Record<string, unknown>)['__errandPageRegistry'] = { refs: new Map([['e1', new WeakRef(element)]]) };
}

describe('pressRef', () => {
  it('Enter in a field submits with the form\'s default button, whose formaction the approval was read from', () => {
    document.body.innerHTML = `<form action="/form"><input name="q"><button formaction="/elsewhere" formmethod="post">Go</button><button>Other</button></form>`;
    const form = document.querySelector('form')!;
    const submit = vi.fn();
    form.requestSubmit = submit;
    registry(document.querySelector('input')!);
    pressRef('e1', 'Enter', 'Enter', 13);
    expect(submit).toHaveBeenCalledWith(document.querySelector('button'));
  });

  it('does not submit when the page took the key, nor in a textarea', () => {
    document.body.innerHTML = `<form action="/form"><input name="q"><button>Go</button></form>`;
    const form = document.querySelector('form')!;
    const submit = vi.fn();
    form.requestSubmit = submit;
    const input = document.querySelector('input')!;
    input.addEventListener('keydown', (event) => event.preventDefault());
    registry(input);
    pressRef('e1', 'Enter', 'Enter', 13);
    expect(submit).not.toHaveBeenCalled();
  });
});
