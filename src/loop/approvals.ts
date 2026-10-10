/*
 * The owner's approvals for one conversation: the run controller's gate.
 *
 * The controller asks whether a site or a form submission is allowed
 * (`verdict`, `submitVerdict`); when the conversation has no answer yet, a
 * card goes up (`ask`, `askSubmit`) and the call waits for the owner. Their
 * answer is recorded in the conversation's scope before the call goes on —
 * nothing here outlives the conversation. Auto covers sites, never a form
 * that sends data.
 */

import type { AskReason, Fingerprint } from '../controller/controller.js';
import { decide, decideSubmission, submitVerdict, verdict, type Decision, type Mode, type SubmitTarget, type Verdict } from '../scope/scope.js';
import type { LoopHost } from './host.js';
import type { Approval } from './protocol.js';
import { Waiter } from './waiter.js';

export class Approvals {
  readonly #host: LoopHost;
  readonly #mode: { set(mode: Mode): Promise<void> };
  readonly #stopped: () => boolean;
  /** The card on screen, waiting for the owner; lost on a restart (the card is then re-raised by the next check). */
  readonly #card = new Waiter<Decision>('deny');
  /** The target of the submission card on screen, to record the answer against. */
  #cardTarget?: SubmitTarget;

  /** `stopped`: whether the owner pressed Stop; a card asked after that is answered Deny at once. */
  constructor(host: LoopHost, mode: { set(mode: Mode): Promise<void> }, stopped: () => boolean) {
    this.#host = host;
    this.#mode = mode;
    this.#stopped = stopped;
  }

  verdict(origin: string): Verdict {
    return verdict(origin, this.#host.state().scope);
  }

  submitVerdict(target: SubmitTarget): Verdict {
    return submitVerdict(target, this.#host.state().scope);
  }

  /** Show a card and wait for the owner. The decision is recorded before the promise resolves. */
  ask(origin: string, reason: AskReason): Promise<Decision> {
    // A Stop while the card is up answers it as Deny; nothing is dispatched.
    if (this.#stopped()) return Promise.resolve('deny');
    const answered = this.#card.ask();
    this.#host.state().approval = { id: this.#id('a'), kind: 'origin', origin, reason };
    this.#host.trace({ kind: 'card', card: 'site', origin, reason });
    this.#host.note(reason === 'blocked' ? `The page tried to go to ${origin}. Allow it?` : `Asking you about ${origin}.`);
    void this.#host.save();
    return answered;
  }

  /** The submission card: where the form goes and what the agent filled in. Asked in Auto too. */
  askSubmit(fingerprint: Fingerprint): Promise<Decision> {
    if (this.#stopped()) return Promise.resolve('deny');
    const answered = this.#card.ask();
    this.#cardTarget = { pageOrigin: fingerprint.frameOrigin, action: fingerprint.action, method: fingerprint.method };
    const approval: Approval = {
      id: this.#id('s'), kind: 'submit', origin: fingerprint.frameOrigin, reason: 'submit',
      submit: { action: fingerprint.action, method: fingerprint.method, submitter: fingerprint.submitter?.name ?? '', fields: fingerprint.fields },
    };
    this.#host.state().approval = approval;
    this.#host.trace({ kind: 'card', card: 'form', origin: fingerprint.action, reason: 'submit' });
    this.#host.note(`Asking you before submitting a form to ${fingerprint.action}.`);
    void this.#host.save();
    return answered;
  }

  /** The owner answered a card. An answer for any other card (or none) is ignored. */
  async decide(id: string, decision: Decision): Promise<void> {
    const state = this.#host.state();
    const approval = state.approval;
    if (!approval || approval.id !== id) return;
    this.#host.trace({ kind: 'answer', card: approval.kind === 'submit' ? 'form' : 'site', decision });
    if (approval.kind === 'submit') {
      // Auto never covers forms: an "auto" answer here counts as once.
      const answer: Decision = decision === 'auto' ? 'once' : decision;
      if (this.#cardTarget) state.scope = decideSubmission(state.scope, this.#cardTarget, answer);
      this.#cardTarget = undefined;
      state.approval = undefined;
      this.#host.note(answer === 'deny' ? 'Denied the form submission.'
        : answer === 'chat' ? `Allowed submissions to ${approval.submit?.action} for this conversation.` : 'Allowed this form submission.');
      await this.#host.save();
      this.#card.answer(answer);
      return;
    }
    state.scope = decide(state.scope, approval.origin, decision);
    if (decision === 'auto') await this.#mode.set('auto');
    await this.#host.contain();
    state.approval = undefined;
    this.#host.note(decision === 'deny' ? `Denied ${approval.origin}.`
      : decision === 'chat' ? `Allowed ${approval.origin} for this conversation.`
        : decision === 'auto' ? 'Auto is on: sites are approved without asking for the rest of this conversation, and so are searches and filters. A form that sends data still asks.'
          : `Allowed ${approval.origin} for this request.`);
    await this.#host.save();
    this.#card.answer(decision);
  }

  /** Turn Auto on or off from the panel; the next conversation starts in the same mode. */
  async setMode(mode: Mode): Promise<void> {
    const state = this.#host.state();
    if (state.scope.mode === mode) return;
    state.scope = { ...state.scope, mode };
    await this.#mode.set(mode);
    // In a conversation, the change is part of its story; before one, the composer shows it.
    if (state.transcript.length > 0) this.#host.note(mode === 'auto' ? 'Auto is on: sites are approved without asking, and so are searches and filters. A form that sends data still asks.' : 'Auto is off: the agent asks before each new site again.');
    await this.#host.contain();
    await this.#host.save();
  }

  #id(prefix: string): string {
    return `${prefix}-${this.#host.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
