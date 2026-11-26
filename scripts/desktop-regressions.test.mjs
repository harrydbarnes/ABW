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

  for (const name of [
    'report.pdf',
    'budget.xlsx',
    'Nuffield Health_Hospitals_Youtube Media Plan_Jul-Oct 26_V9.xlsx',
    'export.csv',
    'data.tsv',
    'notes.docx',
    'Picture1.png',
    'photo.jpg',
    'banner.webp',
    'anim.gif',
  ]) {
    assert.match(name, abwSupportedFileName);
    assert.equal(name.match(abwSupportedFileName)?.[0], name);
    assert.equal(abwLooksLikeDownloadUrl(`https://www.wrike.com/files/${encodeURIComponent(name)}`), true);
  }
  assert.doesNotMatch('archive.zip', abwSupportedFileName);
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

test('injected theme, corner, and custom-scheme IPC are gated to wrike.com hosts', () => {
  const hostStart = source.indexOf('const abwIsWrikeHost = () => {');
  const hostEnd = source.indexOf('let abwSpellApplyTimer = 0;', hostStart);
  assert.ok(hostStart >= 0 && hostEnd > hostStart, 'abwIsWrikeHost must exist in the injected script');

  const schemeStart = source.indexOf('const abwSchemeQueue = [];');
  const schemeEnd = source.indexOf('const abwDetectWrikeInboxUnread =', schemeStart);
  assert.ok(schemeStart >= 0 && schemeEnd > schemeStart, 'abwEmitScheme must exist in the injected script');

  const makeSandbox = (hostname) => {
    const navigated = [];
    const mockWindow = {
      location: {
        hostname,
        set href(value) {
          navigated.push(value);
        },
      },
      setTimeout: (fn) => {
        fn();
        return 1;
      },
      addEventListener: () => {},
    };
    const mockDocument = { readyState: 'complete' };
    const { abwIsWrikeHost, abwEmitScheme } = new Function(
      'window',
      'document',
      `${source.slice(hostStart, hostEnd)}; ${source.slice(schemeStart, schemeEnd)}; return { abwIsWrikeHost, abwEmitScheme };`,
    )(mockWindow, mockDocument);
    return { abwIsWrikeHost, abwEmitScheme, navigated };
  };

  const okta = makeSandbox('wppmedia.okta.com');
  assert.equal(okta.abwIsWrikeHost(), false);
  okta.abwEmitScheme('abw-theme://detected?theme=default');
  assert.deepEqual(okta.navigated, []);

  assert.equal(makeSandbox('evilwrike.com').abwIsWrikeHost(), false);
  assert.equal(makeSandbox('').abwIsWrikeHost(), false);

  const wrike = makeSandbox('www.wrike.com');
  assert.equal(wrike.abwIsWrikeHost(), true);
  wrike.abwEmitScheme('abw-theme://detected?theme=default');
  assert.deepEqual(wrike.navigated, ['abw-theme://detected?theme=default']);

  assert.equal(makeSandbox('wrike.com').abwIsWrikeHost(), true);
  assert.equal(makeSandbox('app-eu.wrike.com').abwIsWrikeHost(), true);

  for (const fnMarker of [
    'const abwScheduleCornerSync = () => {\n    if (abwAutoDownload || !abwIsWrikeHost()',
    'const abwSyncWrikeContentCorner = (fast = false) => {\n    if (abwAutoDownload || !abwIsWrikeHost()',
    'const abwReportWrikeTheme = (force = false) => {\n    if (abwAutoDownload || !abwIsWrikeHost()',
    'const abwScheduleThemeDetect = (delay = 250) => {\n    if (abwAutoDownload || !abwIsWrikeHost()',
  ]) {
    const normalizedSource = source.replace(/\r\n/g, '\n');
    assert.ok(normalizedSource.includes(fnMarker), `Expected host gate in: ${fnMarker}`);
  }
});

test('task-po script detects task panels without URL id gate and waits for the Show more fields control', () => {
  const poSource = readFileSync(new URL('../src-tauri/src/task-po.js', import.meta.url), 'utf8');
  assert.doesNotMatch(poSource, /\(\?:[?&#]\(\?:id\|taskId/);
  assert.match(poSource, /function expandMoreIfNeeded\(/);
  assert.match(poSource, /expandedMoreFor/);
  assert.match(poSource, /\/\^show more fields\$\/i\.test/);
  assert.match(poSource, /hasCampaignDates\(values\) \|\| Date.now\(\) >= pendingManualCheck.deadline/);
  assert.match(poSource, /if \(document\.hidden\) return;/);
  assert.match(poSource, /panel\.textContent/);
});

test('startup opens Wrike immediately through its normal tab path', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const native = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.match(app, /if \(next\.showLaunchSplash\)/);
  assert.match(app, /if \(next\.launchWrikeOnStart\) \{\s+await openStartupTabs/);
  assert.doesNotMatch(app, /waitForLaunchSplash/);
  assert.doesNotMatch(native, /start_hidden/);
});

test('PO button is busy only while an automatic lookup is in progress', () => {
  const poSource = readFileSync(new URL('../src-tauri/src/task-po.js', import.meta.url), 'utf8');
  const start = poSource.indexOf('  function setStatus(status)');
  const end = poSource.indexOf('  window.__abwReceivePoStatus', start);
  assert.ok(start >= 0 && end > start);
  const attributes = new Map();
  const button = {
    style: {},
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: name => attributes.delete(name),
  };
  const setStatus = new Function('button', poSource.slice(start, end) + 'return setStatus;')(button);

  for (const [status, label] of [
    ['checked', '✓ PO Checked'], ['review', 'Review PO'],
    ['signin', 'Sign in to Prisma'], ['unavailable', 'Check PO'],
  ]) {
    setStatus('checking');
    assert.equal(button.textContent, 'Checking PO…');
    assert.equal(attributes.get('aria-busy'), 'true');
    setStatus(status);
    assert.equal(button.textContent, label);
    assert.equal(attributes.has('aria-busy'), false);
  }
  assert.match(poSource, /function clearPending\(\)/);
  assert.match(poSource, /pendingTimer = setTimeout/);
});

test('preview installer hooks target abw.exe and injected script gates hidden tabs and drag corner sync', () => {
  const previewHooks = readFileSync(new URL('../src-tauri/assets/installer-hooks-preview.nsh', import.meta.url), 'utf8');
  assert.match(previewHooks, /\$INSTDIR\\abw\.exe/);
  assert.doesNotMatch(previewHooks, /ABW Preview\.exe/);

  assert.match(source, /document\.hidden/);
  assert.match(source, /abwCornerDragActive/);
  const dragDecl = source.indexOf('let abwCornerDragActive = false;');
  const cornerFn = source.indexOf('const abwSyncWrikeContentCorner =');
  assert.ok(dragDecl >= 0 && cornerFn > dragDecl, 'abwCornerDragActive must be declared before abwSyncWrikeContentCorner');
});

test('injected file preview dismissal targets Wrike proofing viewer only and ignores Show more', () => {
  const fnStart = source.indexOf('const abwProofingViewerSelector =');
  const fnEnd = source.indexOf('const abwPatchWindowOpen =', fnStart);
  assert.ok(fnStart >= 0 && fnEnd > fnStart, 'Proofing viewer download helpers must exist');
  const snippet = source.slice(fnStart, fnEnd);
  assert.match(snippet, /wrike-proofing-app/);
  assert.match(snippet, /proofing-header-close/);
  assert.match(snippet, /file-list-expander/);
  assert.match(snippet, /wrike-attachments-list-item/);
  assert.match(snippet, /attachment-list-item-download/);
  assert.match(snippet, /abwShowPreviewLoading/);
  assert.doesNotMatch(snippet, /\[role="dialog"\]/);
  assert.doesNotMatch(snippet, /KeyboardEvent\(["']keydown["']/);

  const poSource = readFileSync(new URL('../src-tauri/src/task-po.js', import.meta.url), 'utf8');
  assert.match(poSource, /wrike-proofing-app,\s*proofing-viewer,\s*#abw-preview-loading-overlay/);
  assert.match(poSource, /button\.style\.zIndex\s*=\s*'2147483645'/);

  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const dlStart = appSource.indexOf('subscribeToDownloadCompleted(');
  const dlEnd = appSource.indexOf('subscribeToDownloadDeleted(', dlStart);
  assert.ok(dlStart >= 0 && dlEnd > dlStart);
  const dlSnippet = appSource.slice(dlStart, dlEnd);
  assert.match(dlSnippet, /setScreen\("files"\)/);
  assert.match(dlSnippet, /hideWrike\(/);
});


