import { describe, it, expect } from 'vitest';
import { normalizeText, tokenize } from '../../src/core/text.js';

describe('normalizeText', () => {
  it('lowercases input', () => {
    expect(normalizeText('TREADMILL')).toBe('treadmill');
  });

  it('strips punctuation runs and replaces them with a single space', () => {
    expect(normalizeText('Let\'s go, now!')).toBe('let s go now');
  });

  it('collapses repeated whitespace into a single space', () => {
    expect(normalizeText('treadmill    workout')).toBe('treadmill workout');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeText('  TREADMILL!! ')).toBe('treadmill');
  });

  it('treats straight and curly quotes as punctuation', () => {
    expect(normalizeText('‘treadmill’ “workout”')).toBe('treadmill workout');
  });

  it('returns an empty string for empty input', () => {
    expect(normalizeText('')).toBe('');
  });

  it('does not fuse adjacent words when punctuation is removed', () => {
    // A naive "strip to empty" implementation would produce "helloworld".
    expect(normalizeText('hello,world')).toBe('hello world');
  });
});

describe('tokenize', () => {
  it('removes built-in stopwords', () => {
    expect(tokenize('I want to work out on the treadmill')).toEqual(['out', 'treadmill']);
  });

  it('returns normalized, space-split tokens with punctuation stripped', () => {
    expect(tokenize('treadmill, please!!')).toEqual(['treadmill', 'please']);
  });

  it('returns an empty array for empty input', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('returns an empty array when every token is a stopword', () => {
    expect(tokenize('the a an my on at to for with i')).toEqual([]);
  });

  it('preserves the order tokens appear in', () => {
    expect(tokenize('running then treadmill then basketball')).toEqual([
      'running',
      'then',
      'treadmill',
      'then',
      'basketball',
    ]);
  });
});
