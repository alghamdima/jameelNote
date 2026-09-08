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
  'transcription-readiness.ts'
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
  resolveTranscriptionEngine,
  getReadinessCommands,
  isAnyModelDownloading,
} = loadTsModule(modulePath);

// The bug this guards: the pre-flight gate used to check Parakeet no matter what
// the saved config said, so a localWhisper setup was blocked from recording even
// with a downloaded Whisper model.
assert.equal(
  resolveTranscriptionEngine('localWhisper'),
  'whisper',
  'a localWhisper config must be checked against the Whisper engine'
);

assert.equal(
  resolveTranscriptionEngine('parakeet'),
  'parakeet',
  'a parakeet config must still be checked against the Parakeet engine'
);

// No saved config means the Rust default, which is localWhisper.
assert.equal(resolveTranscriptionEngine(undefined), 'whisper', 'missing provider must fall back to Whisper');
assert.equal(resolveTranscriptionEngine(null), 'whisper', 'null provider must fall back to Whisper');
assert.equal(resolveTranscriptionEngine(''), 'whisper', 'empty provider must fall back to Whisper');

// Compared as JSON because the module runs in its own vm context, so its objects
// do not share this realm's Object.prototype.
assert.equal(
  JSON.stringify(getReadinessCommands('whisper')),
  JSON.stringify({
    init: 'whisper_init',
    hasAvailableModels: 'whisper_has_available_models',
    listModels: 'whisper_get_available_models',
  }),
  'Whisper readiness must use the whisper_* commands'
);

assert.equal(
  JSON.stringify(getReadinessCommands('parakeet')),
  JSON.stringify({
    init: 'parakeet_init',
    hasAvailableModels: 'parakeet_has_available_models',
    listModels: 'parakeet_get_available_models',
  }),
  'Parakeet readiness must use the parakeet_* commands'
);

// Rust serializes ModelStatus::Downloading as an object, the others as strings.
assert.equal(
  isAnyModelDownloading([{ status: 'Missing' }, { status: { Downloading: { progress: 12 } } }]),
  true,
  'an object-shaped Downloading status counts as downloading'
);

assert.equal(
  isAnyModelDownloading([{ status: 'Available' }, { status: 'Missing' }]),
  false,
  'available and missing models are not downloads in progress'
);

assert.equal(isAnyModelDownloading([]), false, 'no models means no download in progress');
assert.equal(isAnyModelDownloading(undefined), false, 'a failed model listing means no download in progress');

console.log('transcription-readiness tests passed');
