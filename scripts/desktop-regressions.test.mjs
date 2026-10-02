import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const start = source.indexOf('const selectedWord = () => {');
const end = source.indexOf('const nearestTextWord =', start);
assert.ok(start >= 0 && end > start, 'Dictionary helpers must exist in the injected script');
const helpers = new Function('window', `${source.slice(start, end)}; return { selectedWord, wordFromText };`);

test('injected dictionary extracts complete Unicode words', () => {
  for (const word of ['Harry', 'campaign', 'Wrike', 'café', 'Client123', "O'Neill", 'follow-up']) {
    const { selectedWord, wordFromText } = helpers({
      getSelection: () => ({ isCollapsed: false, toString: () => word }),
    });
    assert.equal(selectedWord(), word);
    assert.equal(wordFromText(` ${word} `, 2), word);
  }
});

test('dictionary ignores collapsed and empty selections', () => {
  assert.equal(helpers({ getSelection: () => null }).selectedWord(), '');
  const { selectedWord, wordFromText } = helpers({
    getSelection: () => ({ isCollapsed: true, toString: () => 'Harry' }),
  });
  assert.equal(selectedWord(), '');
  assert.equal(wordFromText('', 0), '');
  assert.equal(wordFromText('Wrike', 999), 'Wrike');
});
