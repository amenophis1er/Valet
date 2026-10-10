import { describe, expect, it } from 'vitest';
import { decide, decideSubmission, newScope, nextRun, originOf, reachable, submitVerdict, verdict } from './scope.js';

describe('originOf', () => {
  it('keeps scheme, host and port, and nothing for non-web URLs', () => {
    expect(originOf('https://Mail.Example.com:8443/inbox?x=1#y')).toBe('https://mail.example.com:8443');
    expect(originOf('http://localhost:5173/')).toBe('http://localhost:5173');
    for (const url of ['about:blank', 'chrome://settings', 'data:text/html,x', 'javascript:alert(1)', 'not a url']) expect(originOf(url)).toBeNull();
  });
});

describe('sites', () => {
  it('asks by default; Allow once lasts one request, Allow in this chat the conversation', () => {
    let scope = newScope();
    expect(verdict('https://news.test', scope)).toBe('ask');
    scope = decide(decide(scope, 'https://news.test', 'once'), 'https://shop.test', 'chat');
    expect(verdict('https://news.test', scope)).toBe('allowed');
    expect(verdict('https://shop.test', scope)).toBe('allowed');
    scope = nextRun(scope);
    expect(verdict('https://news.test', scope)).toBe('ask');
    expect(verdict('https://shop.test', scope)).toBe('allowed');
  });

  it('a Deny lasts the request and beats the rest; the next request can ask again', () => {
    let scope = decide(newScope(), 'https://shop.test', 'chat');
    scope = decide(scope, 'https://shop.test', 'deny');
    expect(verdict('https://shop.test', scope)).toBe('denied');
    expect(verdict('https://shop.test', nextRun(scope))).toBe('ask');
  });

  it('Auto approves every site and blocks none, and a form that only reads, never one that sends data', () => {
    const scope = decide(newScope(), 'https://shop.test', 'auto');
    expect(scope.mode).toBe('auto');
    expect(verdict('https://anything.test', scope)).toBe('allowed');
    expect(reachable(scope)).toBeNull();
    expect(submitVerdict({ pageOrigin: 'https://shop.test', action: 'https://shop.test/pay', method: 'POST' }, scope)).toBe('ask');
    expect(submitVerdict({ pageOrigin: 'https://shop.test', action: 'https://shop.test/search', method: 'GET' }, scope)).toBe('allowed');
    // Ask mode asks for a search too; a denied search stays denied in Auto.
    expect(submitVerdict({ pageOrigin: 'https://shop.test', action: 'https://shop.test/search', method: 'GET' }, newScope())).toBe('ask');
    const denied = decideSubmission(scope, { pageOrigin: 'https://shop.test', action: 'https://shop.test/search', method: 'GET' }, 'deny');
    expect(submitVerdict({ pageOrigin: 'https://shop.test', action: 'https://shop.test/search', method: 'GET' }, denied)).toBe('denied');
  });

  it('compares origins exactly: a subdomain or another port is another origin', () => {
    const scope = decide(newScope(), 'https://mail.example.com', 'chat');
    expect(verdict('https://example.com', scope)).toBe('ask');
    expect(verdict('https://mail.example.com:444', scope)).toBe('ask');
    expect(verdict('http://mail.example.com', scope)).toBe('ask');
    expect(reachable(scope)).toEqual(['https://mail.example.com']);
  });
});

describe('forms', () => {
  const pay = { pageOrigin: 'https://shop.test', action: 'https://shop.test/pay', method: 'POST' };
  it('Allow once leaves nothing behind; Allow in this chat covers that destination; Deny lasts the request', () => {
    let scope = decideSubmission(newScope(), pay, 'once');
    expect(submitVerdict(pay, scope)).toBe('ask');
    scope = decideSubmission(scope, pay, 'chat');
    expect(submitVerdict(pay, scope)).toBe('allowed');
    expect(submitVerdict({ ...pay, action: 'https://shop.test/other' }, scope)).toBe('ask');
    scope = decideSubmission(scope, pay, 'deny');
    expect(submitVerdict(pay, scope)).toBe('denied');
    expect(submitVerdict(pay, nextRun(scope))).toBe('ask');
  });
});
