import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const modulePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'lib',
  'summary-context-draft.ts'
);
const require = createRequire(import.meta.url);

function loadTsModule(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;

  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    require,
  });
  return module.exports;
}

const {
  summaryContextDraftKey,
  readSummaryContextDraft,
  writeSummaryContextDraft,
} = loadTsModule(modulePath);

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = String(value);
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

// Drafts are per meeting, so one meeting's context never leaks into another.
assert.notEqual(
  summaryContextDraftKey('meeting-a'),
  summaryContextDraftKey('meeting-b'),
  'each meeting must get its own draft key'
);

const store = fakeStorage();
writeSummaryContextDraft(store, 'meeting-a', 'Sales call with a school district');
assert.equal(
  readSummaryContextDraft(store, 'meeting-a'),
  'Sales call with a school district',
  'a written draft must read back'
);
assert.equal(readSummaryContextDraft(store, 'meeting-b'), '', 'an unwritten meeting has no draft');

// Clearing the box must clear the stored draft rather than leaving a stale one.
writeSummaryContextDraft(store, 'meeting-a', '   ');
assert.equal(readSummaryContextDraft(store, 'meeting-a'), '', 'a blank draft must be cleared');
assert.equal(
  summaryContextDraftKey('meeting-a') in store.data,
  false,
  'clearing must remove the key instead of storing an empty string'
);

// A missing meeting id has nowhere to store a draft; it must not throw.
assert.equal(readSummaryContextDraft(store, undefined), '', 'no meeting id reads as empty');
writeSummaryContextDraft(store, undefined, 'orphan');
assert.equal(Object.keys(store.data).length, 0, 'no meeting id writes nothing');

// Storage can be unavailable (disabled site data, a webview quirk). It must degrade, not crash.
const throwingStorage = {
  getItem: () => {
    throw new Error('storage disabled');
  },
  setItem: () => {
    throw new Error('storage disabled');
  },
  removeItem: () => {
    throw new Error('storage disabled');
  },
};
assert.equal(readSummaryContextDraft(throwingStorage, 'meeting-a'), '', 'a throwing read degrades to empty');
assert.doesNotThrow(
  () => writeSummaryContextDraft(throwingStorage, 'meeting-a', 'text'),
  'a throwing write must be swallowed'
);
assert.equal(readSummaryContextDraft(null, 'meeting-a'), '', 'absent storage reads as empty');
assert.doesNotThrow(() => writeSummaryContextDraft(null, 'meeting-a', 'text'), 'absent storage writes nothing');

console.log('summary-context-draft tests passed');
