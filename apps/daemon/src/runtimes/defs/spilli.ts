import { fileURLToPath } from 'node:url';

import { DEFAULT_MODEL_OPTION } from './shared.js';
import type { RuntimeAgentDef } from '../types.js';

const DEFAULT_SPILLI_MODEL = 'Openai_Gpt Oss 20b';

function spilliRunnerPath(): string {
  return fileURLToPath(new URL('../spilli-runner.js', import.meta.url));
}

export const spilliAgentDef = {
  id: 'spilli',
  name: 'SpiLLI',
  bin: 'open-design-spilli-runner',
  internalNodeEntrypoint: 'spilli-runner.js',
  versionArgs: ['--version'],
  fallbackModels: [
    DEFAULT_MODEL_OPTION,
    { id: DEFAULT_SPILLI_MODEL, label: DEFAULT_SPILLI_MODEL },
  ],
  buildArgs: (_prompt, _imagePaths, _extraAllowedDirs, options = {}, runtimeContext = {}) => {
    const args = [spilliRunnerPath()];
    const model = options.model && options.model !== 'default'
      ? options.model
      : DEFAULT_SPILLI_MODEL;
    args.push('--model', model);
    if (runtimeContext.cwd) {
      args.push('--cwd', runtimeContext.cwd);
    }
    return args;
  },
  promptViaStdin: true,
  streamFormat: 'json-event-stream',
  eventParser: 'spilli',
  installUrl: 'https://github.com/synaptrixai/SpiLLI/tree/main/Tutorials/NodeJS',
  docsUrl: 'https://github.com/synaptrixai/SpiLLI/tree/main/Tutorials/NodeJS',
} satisfies RuntimeAgentDef;
