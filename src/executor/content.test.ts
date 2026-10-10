/**
 * @vitest-environment jsdom
 *
 * The page side's submission facts: which actions
 * submit a form, the effective submitter, and the fingerprint of what would be
 * sent — including every field the agent edited, across observations.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ContentApi } from './content.js';

let api: ContentApi;

beforeEach(async () => {
  // jsdom lays nothing out and has no scrollIntoView.
  Element.prototype.scrollIntoView = () => undefined;
  (globalThis as Record<string, unknown>)['__errandPageRegistry'] = undefined;
  await import('./content.js');
  api = (globalThis as unknown as Record<string, ContentApi>)['__errandPage']!;
});

function refFor(name: string): string {
  const observed = api.observe();
  const found = observed.elements.find((element) => element.name.includes(name));
  if (!found) throw new Error(`no element named ${name}`);
  return found.id;
}

describe('submission facts', () => {
  it('knows a submit button submits and a plain button does not', () => {
    document.body.innerHTML = `<form action="/pay?x=1#top" method="post"><label>Name <input name="name"></label>
      <button type="button">Preview</button><button>Pay</button></form>`;
    expect(api.submitFacts(refFor('Preview'), 'click')).toEqual({ ok: true, submits: false });
    const facts = api.submitFacts(refFor('Pay'), 'click');
    expect(facts.submits).toBe(true);
    expect(facts.fingerprint).toMatchObject({ action: `${location.origin}/pay?x=1`, method: 'POST', submitter: { role: 'button', name: 'Pay' } });
  });

  it("uses the default button's formaction and formmethod for Enter in a field", () => {
    document.body.innerHTML = `<form action="/form" method="get"><label>Query <input name="q"></label>
      <button formaction="/elsewhere" formmethod="post">Go</button><button>Other</button></form>`;
    const facts = api.submitFacts(refFor('Query'), 'enter');
    expect(facts.fingerprint).toMatchObject({ action: `${location.origin}/elsewhere`, method: 'POST', submitter: { name: 'Go' } });
    expect(api.submitFacts(refFor('Query'), 'space')).toEqual({ ok: true, submits: false });
  });

  it('carries the current value of every field the agent edited in that form, across observations', () => {
    document.body.innerHTML = `<form action="/pay" method="post"><label>Name <input name="name"></label>
      <label>Card <input name="card"></label><label>Size <select name="size"><option>S</option><option>L</option></select></label>
      <label>Secret <input type="password" name="pw"></label><button>Pay</button></form>
      <form action="/other"><label>Elsewhere <input name="e"></label></form>`;
    api.locate(refFor('Name'), { focus: true, clear: true });
    (document.querySelector('input[name=name]') as HTMLInputElement).value = 'Amen';
    api.choose(refFor('Size'), 'L');
    api.locate(refFor('Elsewhere'), { focus: true, clear: true });
    const fields = api.submitFacts(refFor('Pay'), 'click').fingerprint!.fields;
    expect(fields).toEqual([{ name: 'name', value: 'Amen' }, { name: 'size', value: 'L' }]);
    // A later edit changes the fingerprint: that is what makes a new card.
    (document.querySelector('input[name=name]') as HTMLInputElement).value = 'Someone else';
    expect(api.submitFacts(refFor('Pay'), 'click').fingerprint!.fields[0]).toEqual({ name: 'name', value: 'Someone else' });
  });

  it('never carries a password value', () => {
    document.body.innerHTML = `<form action="/login" method="post"><label>Pass <input type="password" name="pw" value="hunter2"></label><button>Sign in</button></form>`;
    api.locate(refFor('Pass'), {});
    expect(JSON.stringify(api.submitFacts(refFor('Sign in'), 'click'))).not.toContain('hunter2');
  });
});

describe('clicked choices in the fingerprint', () => {
  it('shows the chosen radio and each clicked checkbox, on or off', () => {
    document.body.innerHTML = `<form action="/post" method="post">
      <label>Small <input type="radio" name="size" value="small"></label><label>Medium <input type="radio" name="size" value="medium"></label>
      <label>Onion <input type="checkbox" name="topping" value="onion"></label><label>Bacon <input type="checkbox" name="topping" value="bacon" checked></label>
      <button>Submit order</button></form>`;
    for (const name of ['Small', 'Medium', 'Onion', 'Bacon']) {
      api.locate(refFor(name), { mark: true });
      (document.querySelector(`input[value=${name.toLowerCase()}]`) as HTMLInputElement).click();
    }
    expect(api.submitFacts(refFor('Submit order'), 'click').fingerprint!.fields).toEqual([
      { name: 'size', value: 'medium' }, { name: 'topping', value: 'onion' }, { name: 'topping', value: '(unchecked)' },
    ]);
  });
});


describe('a click by point', () => {
  it('lands on the control around the point, so text inside a submit button is that button', () => {
    document.body.innerHTML = `<form action="/pay" method="post"><input name="amount"><button type="submit"><span id="label">Pay now</span></button></form>`;
    const span = document.getElementById('label')!;
    document.elementFromPoint = () => span;
    api.observe();
    const hit = api.pointAt(5, 5);
    expect(hit).toMatchObject({ ok: true, role: 'button', name: 'Pay now' });
    const facts = api.submitFacts(hit.ref!, 'click');
    expect(facts.submits).toBe(true);
    expect(facts.fingerprint).toMatchObject({ action: `${location.origin}/pay`, method: 'POST' });
  });

  it('keeps plain text as itself', () => {
    document.body.innerHTML = `<p id="p">Just a paragraph</p>`;
    document.elementFromPoint = () => document.getElementById('p');
    api.observe();
    expect(api.submitFacts(api.pointAt(1, 1).ref!, 'click')).toEqual({ ok: true, submits: false });
  });
});

describe('fields that react to each key', () => {
  it('are told apart from plain fields', () => {
    document.body.innerHTML = `
      <label>Plain <input name="a"></label>
      <label>Search <input type="search" name="b"></label>
      <label>City <input role="combobox" aria-expanded="false" name="c"></label>
      <label>Tag <input aria-autocomplete="list" name="d"></label>
      <label>Fruit <input list="fruits" name="e"></label><datalist id="fruits"><option value="Mango"></option></datalist>
      <label>Notes <textarea name="f"></textarea></label>`;
    const keyed = (name: string) => api.locate(refFor(name), {}).keyByKey;
    expect(['Plain', 'Search', 'City', 'Tag', 'Fruit', 'Notes'].map(keyed)).toEqual([false, true, true, true, true, false]);
  });
});
