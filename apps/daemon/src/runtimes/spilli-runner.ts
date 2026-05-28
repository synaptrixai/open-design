import { exec as execCallback } from 'node:child_process';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  createSpilliService,
  parseHarmonyOutput,
  renderHarmonyForDisplay,
} from '@synaptrix/spilli';

const exec = promisify(execCallback);

type JsonRecord = Record<string, unknown>;

type ToolCall = {
  id: string;
  name: string;
  input: JsonRecord;
};

type CliOptions = {
  model: string;
  cwd: string;
};

const DEFAULT_MODEL = 'Openai_Gpt Oss 20b';
const MAX_ITERATIONS = 8;
const MAX_TOOL_OUTPUT_CHARS = 20_000;

function emit(event: JsonRecord): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseArgs(argv: string[]): CliOptions {
  let model = DEFAULT_MODEL;
  let cwd = process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--model' && argv[i + 1]) {
      model = argv[i + 1]!;
      i += 1;
    } else if (arg === '--cwd' && argv[i + 1]) {
      cwd = argv[i + 1]!;
      i += 1;
    }
  }
  return { model, cwd: path.resolve(cwd) };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function redactSecrets(text: string): string {
  let out = text;
  for (const key of ['SPILLI_KEY_PATH', 'OD_TOOL_TOKEN']) {
    const value = process.env[key];
    if (value) out = out.split(value).join(`[redacted:${key}]`);
  }
  return out.replace(/[\w./\\-]+\.pem\b/gi, '[redacted:pem]');
}

async function validateKeyPath(): Promise<string> {
  const raw = process.env.SPILLI_KEY_PATH?.trim();
  if (!raw) {
    throw new Error('SPILLI_KEY_PATH is required. Configure a readable .pem path in Open Design Settings.');
  }
  const keyPath = path.resolve(raw);
  if (!keyPath.toLowerCase().endsWith('.pem')) {
    throw new Error('SPILLI_KEY_PATH must point to a .pem file.');
  }
  const info = await stat(keyPath).catch(() => null);
  if (!info?.isFile()) {
    throw new Error('SPILLI_KEY_PATH must point to a readable .pem file.');
  }
  await access(keyPath);
  return keyPath;
}

function resourceFromEnv(model: string): { model: string; scope: string; team?: string } {
  const rawScope = process.env.SPILLI_SCOPE?.trim();
  const scope =
    rawScope === 'private' || rawScope === 'team' || rawScope === 'public'
      ? rawScope
      : 'public';
  const team = process.env.SPILLI_TEAM?.trim();
  return {
    model,
    scope,
    ...(scope === 'team' && team ? { team } : {}),
  };
}

function safeResolve(workspaceRoot: string, requested: unknown): string {
  const raw = asString(requested).trim();
  if (!raw) throw new Error('file path is required');
  const resolved = path.resolve(workspaceRoot, raw);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('path outside workspace is not allowed');
  }
  return resolved;
}

async function searchText(workspaceRoot: string, query: string): Promise<JsonRecord> {
  const needle = query.trim();
  if (!needle) throw new Error('query is required');
  const results: Array<{ file: string; line: number; preview: string }> = [];
  const ignored = new Set(['.git', '.od', '.tmp', 'node_modules', 'dist', 'build']);

  async function visit(dir: string): Promise<void> {
    if (results.length >= 100) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (results.length >= 100) return;
      if (ignored.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        const content = await readFile(absolute, 'utf8').catch(() => '');
        if (!content) continue;
        const lines = content.split(/\r?\n/u);
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i]?.includes(needle)) {
            results.push({
              file: path.relative(workspaceRoot, absolute),
              line: i + 1,
              preview: lines[i]!.slice(0, 300),
            });
            break;
          }
        }
      }
    }
  }

  await visit(workspaceRoot);
  return { query: needle, count: results.length, results };
}

async function executeTool(workspaceRoot: string, call: ToolCall): Promise<JsonRecord> {
  try {
    if (call.name === 'workspace.readFile') {
      const file = safeResolve(workspaceRoot, call.input.file);
      const content = await readFile(file, 'utf8');
      return {
        ok: true,
        file: path.relative(workspaceRoot, file),
        content: content.slice(0, MAX_TOOL_OUTPUT_CHARS),
        truncated: content.length > MAX_TOOL_OUTPUT_CHARS,
      };
    }
    if (call.name === 'workspace.searchText') {
      return { ok: true, ...(await searchText(workspaceRoot, asString(call.input.query))) };
    }
    if (call.name === 'workspace.writeFile' || call.name === 'workspace.createFile') {
      const file = safeResolve(workspaceRoot, call.input.file);
      const content = asString(call.input.content);
      const overwrite = call.input.overwrite === true || call.name === 'workspace.writeFile';
      const exists = await stat(file).then(() => true).catch(() => false);
      if (exists && !overwrite) {
        return { ok: false, error: 'file already exists', file: path.relative(workspaceRoot, file) };
      }
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, 'utf8');
      return { ok: true, file: path.relative(workspaceRoot, file), bytes: Buffer.byteLength(content) };
    }
    if (call.name === 'container.exec') {
      const cmd = Array.isArray(call.input.cmd)
        ? call.input.cmd.map(String).join(' ')
        : asString(call.input.cmd);
      if (!cmd.trim()) throw new Error('cmd is required');
      const cwd = call.input.cwd ? safeResolve(workspaceRoot, call.input.cwd) : workspaceRoot;
      const timeout = typeof call.input.timeoutMs === 'number'
        ? Math.max(1000, Math.min(call.input.timeoutMs, 60_000))
        : 30_000;
      const { stdout, stderr } = await exec(cmd, {
        cwd,
        timeout,
        maxBuffer: 512 * 1024,
        env: { ...process.env, OD_TOOL_TOKEN: undefined },
      });
      return {
        ok: true,
        stdout: redactSecrets(stdout).slice(0, MAX_TOOL_OUTPUT_CHARS),
        stderr: redactSecrets(stderr).slice(0, MAX_TOOL_OUTPUT_CHARS),
      };
    }
    return { ok: false, error: `tool not allowed: ${call.name}` };
  } catch (error) {
    return {
      ok: false,
      error: redactSecrets(error instanceof Error ? error.message : String(error)),
    };
  }
}

function parseJsonObject(value: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as JsonRecord
      : null;
  } catch {
    return null;
  }
}

function normalizeToolCall(record: JsonRecord, fallbackName?: string): ToolCall | null {
  const name = asString(record.toolName || record.name || fallbackName).trim();
  if (!name) return null;
  const rawArgs = record.args || record.input || {};
  const input = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? rawArgs as JsonRecord
    : {};
  const id = asString(record.callId || record.id).trim() ||
    `spilli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return { id, name, input };
}

function extractToolCalls(raw: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const direct = parseJsonObject(raw.trim());
  if (direct) {
    const directCall = normalizeToolCall(direct);
    if (directCall) calls.push(directCall);
    if (Array.isArray(direct.toolCalls)) {
      for (const item of direct.toolCalls) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const call = normalizeToolCall(item as JsonRecord);
          if (call) calls.push(call);
        }
      }
    }
  }

  const parsed = parseHarmonyOutput(raw);
  if (parsed?.isHarmony && Array.isArray(parsed.messages)) {
    for (const segment of parsed.messages) {
      const recipient = asString(segment?.recipient).trim();
      const terminator = asString(segment?.terminator);
      if (!recipient || (terminator !== 'call' && terminator !== 'end')) continue;
      const payload = parseJsonObject(asString(segment.content).trim());
      const call = normalizeToolCall(payload ?? {}, recipient);
      if (call) calls.push(call);
    }
  }

  const seen = new Set<string>();
  return calls.filter((call) => {
    const key = `${call.name}:${JSON.stringify(call.input)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toolPrompt(): string {
  return [
    'You are an Open Design coding and design agent backed by SpiLLI inference.',
    'When you need workspace information or edits, emit Harmony tool calls or JSON tool calls.',
    'Tool call JSON shape: {"toolName":"workspace.readFile","callId":"id","args":{"file":"path"}}.',
    'Available tools:',
    '- workspace.readFile {"file": string}',
    '- workspace.searchText {"query": string}',
    '- workspace.createFile {"file": string, "content": string, "overwrite"?: boolean}',
    '- workspace.writeFile {"file": string, "content": string}',
    '- container.exec {"cmd": string, "cwd"?: string, "timeoutMs"?: number}',
    'Use workspace-relative paths. Do not print, persist, or reveal secrets.',
  ].join('\n');
}

function buildQuery(userPrompt: string, toolResults: JsonRecord[]): string {
  if (toolResults.length === 0) return userPrompt;
  return [
    userPrompt,
    '',
    'Tool results so far:',
    JSON.stringify(toolResults.slice(-12), null, 2),
  ].join('\n');
}

async function main(): Promise<void> {
  if (process.argv.includes('--version')) {
    process.stdout.write('open-design-spilli-runner 1\n');
    return;
  }

  const options = parseArgs(process.argv.slice(2));
  const userPrompt = await readStdin();
  const keyPath = await validateKeyPath();
  const service = createSpilliService(keyPath);
  const session = service.getOrCreateSession(resourceFromEnv(options.model));
  const toolResults: JsonRecord[] = [];

  emit({ type: 'status', label: 'running', model: options.model });

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    let raw = '';
    let emittedText = false;
    const started = Date.now();
    raw = await session.run(
      { prompt: toolPrompt(), query: buildQuery(userPrompt, toolResults) },
      {
        onChunk: (chunk: string) => {
          raw += chunk;
          emittedText = true;
          emit({ type: 'text_delta', delta: chunk });
        },
      },
    );
    const rendered = renderHarmonyForDisplay(raw);
    const display = asString(rendered?.display) || raw;
    const calls = extractToolCalls(raw);
    if (calls.length === 0) {
      if (!emittedText && display) emit({ type: 'text_delta', delta: display });
      emit({ type: 'usage', durationMs: Date.now() - started });
      return;
    }
    for (const call of calls) {
      emit({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
      const result = await executeTool(options.cwd, call);
      toolResults.push({ callId: call.id, toolName: call.name, ...result });
      emit({
        type: 'tool_result',
        toolUseId: call.id,
        content: redactSecrets(JSON.stringify(result)),
        isError: result.ok !== true,
      });
    }
  }

  emit({
    type: 'error',
    message: `SpiLLI agent reached the ${MAX_ITERATIONS} iteration limit before a final answer.`,
  });
}

main().catch((error) => {
  emit({
    type: 'error',
    message: redactSecrets(error instanceof Error ? error.message : String(error)),
  });
  process.exitCode = 1;
});
