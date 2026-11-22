import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

const source = readFileSync(new URL('../src-tauri/src/wrike-injected.js', import.meta.url), 'utf8');
const start = source.indexOf('const selectedWord = () => {');
const end = source.indexOf('const nearestTextWord =', start);
assert.ok(start >= 0 && end > start, 'Dictionary helpers must exist in the injected script');
const helpers = new Function('window', `${source.slice(start, end)}; return { selectedWord, wordFromText };`);

const themeStart = source.indexOf('const abwWrikeThemeCatalog = [');
const themeEnd = source.indexOf('const abwReportWrikeTheme =', themeStart);
assert.ok(themeStart >= 0 && themeEnd > themeStart, 'Wrike theme detector helpers must exist in the injected script');
const themeHelpers = new Function(
  'window',
  'document',
  'Element',
  `${source.slice(themeStart, themeEnd)}; return { abwWrikeThemeCatalog, abwParseCssColor, abwExtractCssColors, abwMatchWrikeThemeText, abwMatchWrikeThemeColor, abwDetectWrikeThemeFromDom };`,
);

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

test('Wrike theme detector matches sidebar colors and ignores modal overlays', () => {
  class MockElement {
    constructor({
      className = '',
      id = '',
      attributes = [],
      rect = { left: 0, top: 0, width: 160, height: 700 },
      style = { backgroundColor: 'transparent', backgroundImage: 'none', visibility: 'visible', display: 'block' },
      parentElement = null,
      inDialog = false,
    } = {}) {
      this.className = className;
      this.id = id;
      this.attributes = attributes;
      this._rect = rect;
      this._style = style;
      this.parentElement = parentElement;
      this._inDialog = inDialog;
    }
    getBoundingClientRect() {
      return this._rect;
    }
    closest(selector) {
      if (this._inDialog && selector.includes('dialog')) return this;
      return this.parentElement?.closest?.(selector) ?? null;
    }
  }

  const body = new MockElement({
    rect: { left: 0, top: 0, width: 1440, height: 900 },
    style: { backgroundColor: 'rgb(255, 255, 255)', backgroundImage: 'none', visibility: 'visible', display: 'block' },
  });
  const docEl = new MockElement({
    rect: { left: 0, top: 0, width: 1440, height: 900 },
    style: { backgroundColor: 'transparent', backgroundImage: 'none', visibility: 'visible', display: 'block' },
  });
  const sidebar = new MockElement({
    className: 'wrike-left-navigation',
    rect: { left: 0, top: 0, width: 160, height: 880 },
    style: { backgroundColor: 'rgb(0, 57, 64)', backgroundImage: 'none', visibility: 'visible', display: 'block' },
    parentElement: body,
  });
  const modalBackdrop = new MockElement({
    className: 'modal-backdrop',
    rect: { left: 0, top: 0, width: 1440, height: 900 },
    style: { backgroundColor: 'rgba(12, 37, 41, 0.56)', backgroundImage: 'none', visibility: 'visible', display: 'block' },
    parentElement: body,
  });
  const modalDialog = new MockElement({
    className: 'task-modal',
    rect: { left: 10, top: 20, width: 220, height: 700 },
    style: { backgroundColor: 'rgb(255, 255, 255)', backgroundImage: 'none', visibility: 'visible', display: 'block' },
    parentElement: body,
    inDialog: true,
  });

  const mockDocument = {
    documentElement: docEl,
    body,
    elementsFromPoint: () => [modalDialog, modalBackdrop, sidebar, body],
    querySelectorAll: () => [sidebar],
  };
  const mockWindow = {
    getComputedStyle: (el) => el._style,
  };

  const {
    abwParseCssColor,
    abwMatchWrikeThemeColor,
    abwMatchWrikeThemeText,
    abwDetectWrikeThemeFromDom,
  } = themeHelpers(mockWindow, mockDocument, MockElement);

  assert.equal(abwParseCssColor('rgba(12, 37, 41, 0.56)'), null);
  assert.deepEqual(abwParseCssColor('rgb(0, 57, 64)'), { r: 0, g: 57, b: 64, a: 1 });
  assert.equal(abwMatchWrikeThemeColor({ r: 0, g: 57, b: 64 }), 'aquamarine');
  assert.equal(abwMatchWrikeThemeColor({ r: 16, g: 29, b: 62 }), 'default');
  assert.equal(abwMatchWrikeThemeColor({ r: 52, g: 37, b: 113 }), 'imperial-purple');
  assert.equal(abwMatchWrikeThemeText('wrike-theme-woodland-grass'), 'woodland-grass');
  assert.equal(abwDetectWrikeThemeFromDom(), 'aquamarine');
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

test('installer hooks guard startup prompt during passive/update installs and clean up preference key on full uninstall', () => {
  const hooks = readFileSync(new URL('../src-tauri/assets/installer-hooks.nsh', import.meta.url), 'utf8');
  assert.match(hooks, /StrCmp \$UpdateMode 1 abw_startup_apply/);
  assert.match(hooks, /StrCmp \$PassiveMode 1 abw_startup_apply/);
  assert.match(hooks, /DeleteRegKey HKCU "\$\{ABW_PREF_KEY\}"/);
});

test('injected script exposes instant spellcheck toggle and gates open.htm observer', () => {
  assert.match(source, /window\.__abwSetSpellCheck\s*=/);
  assert.match(source, /if \(isLikelyOpenInterstitialPage\(\) && !clickBrowserLink\(\)\)/);
  assert.match(source, /document\.readyState && document\.readyState !== "complete"/);
});


