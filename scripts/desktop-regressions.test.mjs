import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

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

test('release checks accept matching versions and reject mismatched tags', () => {
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const environment = { ...process.env, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: `v${version}` };
  assert.match(execFileSync(process.execPath, ['scripts/release-version.mjs', '--check'], {
    encoding: 'utf8', env: environment,
  }), /is consistent/);
  assert.throws(() => execFileSync(process.execPath, ['scripts/release-version.mjs', '--check'], {
    env: { ...environment, GITHUB_REF_NAME: 'v0.0.0' }, stdio: 'pipe',
  }), /does not match version/);
});

test('tauri updater config specifies valid minisign key, HTTPS GitHub endpoint, and passive install mode', () => {
  const tauriConf = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  assert.equal(tauriConf.bundle?.createUpdaterArtifacts, true);
  const updater = tauriConf.plugins?.updater;
  assert.ok(updater, 'plugins.updater must be configured');
  const decodedKey = Buffer.from(updater.pubkey, 'base64').toString('utf8');
  assert.match(decodedKey, /^untrusted comment: minisign public key:/);
  assert.deepEqual(updater.endpoints, [
    'https://github.com/harrydbarnes/ABW/releases/latest/download/latest.json',
  ]);
  assert.equal(updater.windows?.installMode, 'passive');
});

test('injected download detector recognizes supported extensions including csv and tsv', () => {
  const fnStart = source.indexOf('const abwSupportedFileName =');
  const fnEnd = source.indexOf('const abwFindSupportedFileName =', fnStart);
  assert.ok(fnStart >= 0 && fnEnd > fnStart, 'Download matcher helpers must exist in the injected script');
  const { abwSupportedFileName, abwLooksLikeDownloadUrl } = new Function(
    `${source.slice(fnStart, fnEnd)}; return { abwSupportedFileName, abwLooksLikeDownloadUrl };`,
  )();

  for (const name of ['report.pdf', 'budget.xlsx', 'export.csv', 'data.tsv', 'notes.docx']) {
    assert.match(name, abwSupportedFileName);
    assert.equal(abwLooksLikeDownloadUrl(`https://www.wrike.com/files/${encodeURIComponent(name)}`), true);
  }
  assert.doesNotMatch('avatar.png', abwSupportedFileName);
  assert.equal(abwLooksLikeDownloadUrl('https://www.wrike.com/workspace.htm'), false);
});

test('injected keyboard shortcut handler emits expected abw-shortcut URLs', () => {
  const shortcutStart = source.indexOf('const abwSendShortcut =');
  const shortcutEnd = source.indexOf('const start = () => {', shortcutStart);
  assert.ok(shortcutStart >= 0 && shortcutEnd > shortcutStart, 'Shortcut helpers must exist in the injected script');

  const navigated = [];
  const handle = new Function(
    'window',
    `${source.slice(shortcutStart, shortcutEnd)}; return abwHandleKeyboardShortcuts;`,
  )({
    location: {
      set href(value) {
        navigated.push(value);
      },
    },
  });

  const makeEvent = (overrides) => ({
    isComposing: false,
    metaKey: false,
    altKey: false,
    ctrlKey: true,
    shiftKey: false,
    preventDefaultCalled: false,
    preventDefault() {
      this.preventDefaultCalled = true;
    },
    ...overrides,
  });

  const newTab = makeEvent({ key: 't' });
  handle(newTab);
  assert.equal(newTab.preventDefaultCalled, true);

  const prevTab = makeEvent({ key: 'Tab', shiftKey: true });
  handle(prevTab);

  const tabThree = makeEvent({ key: '3' });
  handle(tabThree);

  const nonCtrl = makeEvent({ key: 't', ctrlKey: false });
  handle(nonCtrl);
  assert.equal(nonCtrl.preventDefaultCalled, false);

  assert.deepEqual(navigated, [
    'abw-shortcut://trigger?action=new-tab',
    'abw-shortcut://trigger?action=prev-tab',
    'abw-shortcut://trigger?action=select-tab&index=3',
  ]);
});

