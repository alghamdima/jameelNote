const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const policy = require('../../src/config/privacy.json');

function loadModule(relativePath, mocks, globals = {}) {
  const filename = path.join(root, relativePath);
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, jsx: ts.JsxEmit.React },
    fileName: filename,
    reportDiagnostics: true,
  });
  assert.deepEqual(result.diagnostics, []);
  const module = { exports: {} };
  vm.runInNewContext(result.outputText, {
    module, exports: module.exports, console,
    require(name) {
      if (name === '@/config/privacy.json') return policy;
      if (Object.hasOwn(mocks, name)) return mocks[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
    ...globals,
  }, { filename });
  return module.exports;
}

test('manual and automatic update checks do not contact the updater', async () => {
  let calls = 0;
  const { UpdateService } = loadModule('src/services/updateService.ts', {
    '@tauri-apps/plugin-updater': { check: () => { calls++; throw new Error('Network must not be used'); } },
    '@tauri-apps/plugin-process': { relaunch: () => { calls++; } },
    '@tauri-apps/api/app': { getVersion: async () => '0.4.0' },
  });
  const service = new UpdateService();
  for (const force of [false, true]) {
    const result = await service.checkForUpdates(force);
    assert.equal(result.available, false);
    assert.equal(result.currentVersion, '0.4.0');
  }
  await assert.rejects(service.downloadAndInstall({
    download: async () => { calls++; }, install: async () => { calls++; },
  }), /disabled/);
  assert.equal(calls, 0);
});

test('analytics cannot be initialized or re-enabled through the frontend API', async () => {
  let calls = 0;
  const { Analytics } = loadModule('src/lib/analytics.ts', {
    '@tauri-apps/api/core': { invoke: async () => { calls++; return true; } },
  });
  await Analytics.init();
  await Analytics.init();
  assert.equal(await Analytics.isEnabled(), false);
  assert.equal(calls, 0);
});

test('mounting the update hook schedules no background check', () => {
  let scheduled = 0;
  let checked = 0;
  const { useUpdateCheck } = loadModule('src/hooks/useUpdateCheck.ts', {
    react: { useState: (initial) => [initial, () => {}], useEffect: (effect) => effect() },
    '@/services/updateService': { updateService: { checkForUpdates: () => { checked++; } } },
    '@/components/UpdateNotification': { showUpdateNotification: () => {} },
  }, { setTimeout: () => { scheduled++; }, clearTimeout: () => {} });
  useUpdateCheck({ checkOnMount: true });
  assert.equal(scheduled, 0);
  assert.equal(checked, 0);
});

test('saved analytics consent is never loaded when analytics is disabled', () => {
  let loaded = 0;
  const { default: Provider } = loadModule('src/components/AnalyticsProvider.tsx', {
    react: {
      createContext: () => ({ Provider: 'provider' }),
      useState: () => [false, () => {}], useRef: () => ({ current: false }),
      useEffect: (effect) => effect(), createElement: () => null,
    },
    '@/lib/analytics': {},
    '@tauri-apps/plugin-store': { load: () => { loaded++; throw new Error('Old opt-in must not be read'); } },
  });
  Provider({ children: null });
  assert.equal(loaded, 0);
});

test('external links in notes are blocked for normal and middle clicks; local routes still work', () => {
  const listeners = {};
  class AnchorTarget {
    constructor(href) { this.href = href; }
    closest() { return { getAttribute: () => this.href }; }
  }
  const { ExternalLinkGuard } = loadModule('src/components/ExternalLinkGuard.tsx', {
    react: { useEffect: (effect) => effect() },
  }, {
    URL, Element: AnchorTarget,
    window: { location: { href: 'http://localhost:3118/notes', origin: 'http://localhost:3118' } },
    document: { addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener: () => {} },
  });
  ExternalLinkGuard();
  for (const type of ['click', 'auxclick']) {
    for (const href of ['https://github.com/example', 'mailto:test@example.com', 'javascript:alert(1)', 'http://[invalid']) {
      let blocked = false;
      listeners[type]({ target: new AnchorTarget(href), preventDefault: () => { blocked = true; }, stopPropagation: () => {} });
      assert.equal(blocked, true, href);
    }
    listeners[type]({ target: new AnchorTarget('/settings'), preventDefault: () => assert.fail('Local route blocked') });
  }
});
