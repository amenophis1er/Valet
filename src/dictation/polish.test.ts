import { describe, expect, it } from 'vitest';
import { finish, sameWords, settle } from './polish.js';

describe('settle: a phrase as it settles, casing only', () => {
  it('capitalizes the start of the text and the start of a sentence', () => {
    expect(settle('', 'find flights to paris', 'en-US')).toBe('Find flights to paris');
    expect(settle('Done. ', 'now the hotel', 'en-US')).toBe('Now the hotel');
    expect(settle('Is it open? ', 'great', 'en')).toBe('Great');
  });

  it('leaves a phrase that continues a sentence alone: a pause is not a period', () => {
    expect(settle('Find flights to', 'paris next friday', 'en-US')).toBe('paris next friday');
  });

  it('writes the English pronoun as "I", with its contractions, and nothing else', () => {
    expect(settle('', 'i think i\'m late and i\'ll call', 'en-US')).toBe('I think I\'m late and I\'ll call');
    expect(settle('Then', 'it is in italy, item i', 'en-US')).toBe('it is in italy, item I');
    expect(settle('Puis', 'i grandi', 'it-IT')).toBe('i grandi');
  });

  it('does nothing in a language the rules are not for', () => {
    expect(settle('', 'привет мир', 'ru-RU')).toBe('привет мир');
    expect(settle('', '你好', 'zh-CN')).toBe('你好');
  });
});

describe('finish: the end of the dictated text', () => {
  it('adds a period, or a question mark to an English question', () => {
    expect(finish('', 'book the cheapest one', 'en-US')).toBe('Book the cheapest one.');
    expect(finish('', 'what time does it open', 'en-US')).toBe('What time does it open?');
    expect(finish('', 'Thanks. can you check the price', 'en-US')).toBe('Thanks. can you check the price?');
  });

  it('keeps end punctuation that is already there, and trailing space', () => {
    expect(finish('', 'Is it open?', 'en-US')).toBe('Is it open?');
    expect(finish('', 'done ', 'en-US')).toBe('Done. ');
  });

  it('capitalizes only at a sentence start', () => {
    expect(finish('Look at this', 'and the next one', 'en-US')).toBe('and the next one.');
  });

  it('asks questions in English only; other languages get a period', () => {
    expect(finish('', 'où est la gare', 'fr-FR')).toBe('Où est la gare.');
    expect(finish('', 'hola', 'ja-JP')).toBe('hola');
  });
});

describe('sameWords: what a cleanup may change', () => {
  it('allows punctuation, casing and apostrophes', () => {
    expect(sameWords('i dont know what time it is', 'I don\'t know. What time is it?')).toBe(false);
    expect(sameWords('i dont know what time it is', 'I don\'t know what time it is.')).toBe(true);
  });

  it('refuses an added, removed or changed word', () => {
    expect(sameWords('book the flight', 'Please book the flight.')).toBe(false);
    expect(sameWords('book the flight', 'Book flight.')).toBe(false);
    expect(sameWords('book the flight', 'Book the flights.')).toBe(false);
  });
});
