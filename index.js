/**
 * dsh-qwen-asr — Qwen3-ASR-Flash speech-to-text for DeepSeek Harness.
 *
 * Two integration points:
 * 1. `agent/pre-step`: uploaded audio attachments are transcribed before the
 *    step reaches the model, and the transcript is appended beside the file
 *    handle (the durable attachment itself is never modified).
 * 2. `qwen_transcribe_audio`: a model-facing tool that transcribes any audio
 *    path and returns both the transcript and the raw Qwen API response.
 */

import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, basename, isAbsolute, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_AUDIO_EXTENSIONS,
  LANGUAGES,
  formatTranscriptFailure,
  formatTranscriptInjection,
  isAudioName,
  normalizeConfig,
  readAudioFileBytes,
  renderRawOutput,
  transcribeAudio,
} from './lib/asr.js';

export const name = 'qwen-asr';
export const inject = ['tools'];

/**
 * Candidate profile directories. A bundle installed by link lives outside the
 * profile's node_modules, so the Host-provided `@deepseek-ai/schemastery`
 * cannot resolve from the plugin's real path. The Host profile is located from
 * its environment first and from the default DSH home layout second, so the
 * settings schema still loads when DSH_* variables are absent from the Host
 * process environment.
 * @returns existing-or-expected profile directories, best first.
 */
function profileDirectories() {
  const dirs = [];
  const add = (value) => {
    if (typeof value === 'string' && value !== '' && !dirs.includes(value)) dirs.push(value);
  };
  add(process.env.DSH_PROFILE_DIR);

  const homes = [];
  const addHome = (value) => {
    if (typeof value === 'string' && value !== '' && !homes.includes(value)) homes.push(value);
  };
  addHome(process.env.DSH_HOME);
  try {
    addHome(join(homedir(), '.dsh'));
  } catch {
    // no home directory available
  }

  for (const home of homes) {
    const profile = process.env.DSH_PROFILE;
    if (typeof profile === 'string' && profile !== '') add(join(home, 'profiles', profile));
    try {
      for (const entry of readdirSync(join(home, 'profiles'), { withFileTypes: true })) {
        if (entry.isDirectory()) add(join(home, 'profiles', entry.name));
      }
    } catch {
      // that home has no profiles yet
    }
  }
  return dirs;
}

/**
 * Resolve `@deepseek-ai/schemastery` from a running profile's node_modules.
 * @returns the schemastery module, or undefined when it cannot be resolved.
 */
async function loadSchemaLibrary() {
  for (const dir of profileDirectories()) {
    const direct = join(dir, 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs');
    const targets = [join(dir, 'package.json')];
    if (existsSync(direct)) targets.push(direct);
    for (const base of targets) {
      try {
        const target = base.endsWith('package.json')
          ? createRequire(base).resolve('@deepseek-ai/schemastery')
          : base;
        const loaded = await import(pathToFileURL(target).href);
        const candidate = loaded?.default ?? loaded;
        const kind = typeof candidate;
        if (
          (kind === 'object' || kind === 'function') &&
          candidate !== null &&
          typeof candidate.object === 'function'
        ) {
          return candidate;
        }
      } catch {
        // try the next target
      }
    }
  }
  return undefined;
}

const schema = await loadSchemaLibrary();

/**
 * Plugin settings schema, rendered by DSH Settings when the library resolves.
 * Without it the plugin still works with the same defaults applied by
 * normalizeConfig() (environment variables and row config stay supported).
 */
let Config;
if (schema !== undefined) {
  try {
    Config = schema.object({
      apiKey: schema
        .string()
        .volatile()
        .description('DashScope API key. Leave empty to read the key from the environment.')
        .default(''),
      apiKeyEnv: schema
        .string()
        .volatile()
        .description('Environment variable that holds the DashScope API key when apiKey is empty.')
        .default('DASHSCOPE_API_KEY'),
      api: schema
        .string()
        .volatile()
        .description(
          'Transcription API: filetrans (async, long audio, ≤1 GB / 12 h) or sync (inline, ≤10 MB / 5 min).',
        )
        .default('filetrans'),
      model: schema
        .string()
        .volatile()
        .description('Async filetrans model id (used when api is filetrans).')
        .default('qwen3-asr-flash-filetrans'),
      syncModel: schema
        .string()
        .description('Inline model id (used only when api is sync).')
        .default('qwen3-asr-flash'),
      dashscopeBaseURL: schema
        .string()
        .volatile()
        .description('DashScope native base URL for temporary upload and async task APIs.')
        .default('https://dashscope.aliyuncs.com'),
      baseURL: schema
        .string()
        .volatile()
        .description('OpenAI-compatible base URL for sync mode.')
        .default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
      language: schema
        .string()
        .volatile()
        .description('Language hint: auto, or a Qwen language code such as zh, yue, en, ja.')
        .default('auto'),
      enableItn: schema
        .boolean()
        .volatile()
        .description('Convert spoken numbers to digits (Chinese and English only).')
        .default(false),
      enableWords: schema
        .boolean()
        .description('Return word-level timestamps in async filetrans results.')
        .default(false),
      autoTranscribe: schema
        .boolean()
        .volatile()
        .description('Transcribe uploaded audio attachments before the step reaches the model.')
        .default(true),
      injectRawOutput: schema
        .boolean()
        .volatile()
        .description('Include the raw Qwen JSON response in the injected transcript.')
        .default(false),
      maxAudioBytes: schema
        .natural()
        .description('Sync-mode inline audio limit, in bytes.')
        .default(7_000_000),
      maxFileBytes: schema
        .natural()
        .volatile()
        .description('Async-mode upload limit, in bytes (DashScope temporary storage caps at 1 GB).')
        .default(1_000_000_000),
      timeoutMs: schema
        .natural()
        .description('Per-request timeout, in milliseconds.')
        .default(120_000),
      uploadTimeoutMs: schema
        .natural()
        .description('Temporary upload timeout, in milliseconds.')
        .default(600_000),
      taskTimeoutMs: schema
        .natural()
        .volatile()
        .description('How long to wait for one async transcription task, in milliseconds.')
        .default(900_000),
      pollIntervalMs: schema
        .natural()
        .description('Async task poll interval, in milliseconds.')
        .default(3_000),
      audioExtensions: schema
        .array(schema.string())
        .description('File extensions treated as audio for automatic transcription.')
        .default([...DEFAULT_AUDIO_EXTENSIONS]),
    });
  } catch {
    Config = undefined;
  }
}

export { Config };

/**
 * Register the pre-step transcriber and the model-facing tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host plugin context.
 * @param {object | undefined} rawConfig Loader row config, already validated by Config when available.
 */
export function apply(ctx, rawConfig) {
  // Editable Config fields are volatile: read them for each operation so a
  // settings write (which updates the same references in place) applies without
  // reloading the plugin.
  const currentConfig = () => normalizeConfig(rawConfig);

  /** attachmentId -> canonical transcription value (bounded). */
  const cache = new Map();
  /** attachmentId -> in-flight transcription promise. */
  const inflight = new Map();

  const log = (message, error) => {
    try {
      ctx.logger?.warn?.(message, error);
    } catch {
      // logging must never break a step
    }
  };
  const service = (key) => {
    try {
      return ctx.get(key);
    } catch {
      return undefined;
    }
  };
  const transcribeBytes = (config, bytes, fileName, signal, override) =>
    transcribeAudio({
      bytes,
      name: fileName,
      config: override === undefined ? config : { ...config, ...override },
      signal,
    });

  /**
   * Transcribe one durable attachment, sharing work across messages and steps.
   * @param {object} config current normalized configuration.
   * @param {object} attachments the Host attachment service.
   * @param {{ attachmentId: string, name?: string, bytes?: number }} ref durable reference.
   * @param {AbortSignal | undefined} signal step cancellation.
   * @returns canonical transcription value.
   */
  const transcribeAttachment = (config, attachments, ref, signal) => {
    const key = `${String(ref.attachmentId)}:${String(ref.bytes ?? 0)}`;
    const cached = cache.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const running = inflight.get(key);
    if (running !== undefined) return running;

    const job = (async () => {
      const chunks = [];
      for await (const chunk of attachments.readFileStream(ref, signal)) {
        chunks.push(Buffer.from(chunk));
      }
      return await transcribeBytes(
        config,
        Buffer.concat(chunks),
        typeof ref.name === 'string' && ref.name !== '' ? ref.name : 'audio',
        signal,
      );
    })();

    inflight.set(key, job);
    return job.then(
      (value) => {
        inflight.delete(key);
        cache.set(key, value);
        if (cache.size > 32) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        return value;
      },
      (error) => {
        inflight.delete(key);
        throw error;
      },
    );
  };

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    const config = currentConfig();
    if (!config.autoTranscribe) return decision;
    if (decision === null || typeof decision !== 'object') return decision;
    if (decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;
    const attachments = service('attachments');
    if (attachments === undefined || typeof attachments.readFileStream !== 'function') {
      return decision;
    }
    const signal = payload?.signal;

    try {
      const messages = [];
      let changed = false;
      for (const message of decision.messages) {
        const content = Array.isArray(message?.content) ? message.content : undefined;
        if (content === undefined) {
          messages.push(message);
          continue;
        }
        const audio = [];
        for (const block of content) {
          if (block?.type !== 'file') continue;
          const ref = block.attachment;
          if (ref === null || typeof ref !== 'object') continue;
          if (typeof ref.attachmentId !== 'string') continue;
          if (!isAudioName(ref.name, config.audioExtensions)) continue;
          audio.push(ref);
        }
        if (audio.length === 0) {
          messages.push(message);
          continue;
        }
        const additions = [];
        for (const ref of audio) {
          if (signal?.aborted) return decision;
          try {
            const value = await transcribeAttachment(config, attachments, ref, signal);
            additions.push({
              type: 'text',
              text: formatTranscriptInjection(ref, value, config.injectRawOutput),
            });
          } catch (error) {
            if (signal?.aborted) return decision;
            log(`qwen-asr: transcription failed for ${String(ref.name ?? 'audio')}`, error);
            additions.push({ type: 'text', text: formatTranscriptFailure(ref, error) });
          }
        }
        if (additions.length === 0) {
          messages.push(message);
          continue;
        }
        messages.push({ ...message, content: [...content, ...additions] });
        changed = true;
      }
      return changed ? { ...decision, messages } : decision;
    } catch (error) {
      if (signal?.aborted) return decision;
      log('qwen-asr: pre-step transcription skipped', error);
      return decision;
    }
  });

  const resolveAudioPath = (input, exec, workingDirectory) => {
    if (typeof input !== 'string' || input.trim() === '') {
      throw new Error('path must be a non-empty string');
    }
    const raw = input.trim();
    if (isAbsolute(raw)) return raw;
    let cwd = process.cwd();
    try {
      const session = exec?.agent?.session;
      if (workingDirectory !== undefined && session !== undefined) {
        cwd = workingDirectory.get(session) ?? cwd;
      }
    } catch {
      // the session may be unavailable to programmatic callers
    }
    return resolvePath(cwd, raw);
  };

  ctx.effect(() =>
    ctx.tools.register({
      name: 'qwen_transcribe_audio',
      description:
        'Transcribe an audio file with Qwen and return the transcript plus the raw ASR response. ' +
        'Long recordings use the asynchronous filetrans model (temporary upload, then polling), ' +
        'so this call can take a while. Use it for audio attachments or an audio path the user ' +
        'names; it cannot read non-audio files.',
      // Raw JSON Schema (the wire form `defineTool` would compile): this plugin
      // registers without importing Host libraries, so the parameter schema is
      // authored directly in the enforced JSON Schema subset.
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Audio file path: absolute, or relative to the session working directory. ' +
              'Uploaded files appear in the conversation as saved read-only paths.',
          },
          language: {
            type: 'string',
            enum: [...LANGUAGES],
            description: 'Language hint; omit to detect the language automatically.',
          },
          enable_itn: {
            type: 'boolean',
            description:
              'Convert spoken numbers to digits (Chinese and English only); defaults to the plugin setting.',
          },
        },
        required: ['path'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'model', 'raw'],
          properties: {
            text: {
              type: 'string',
              description: 'Transcript exactly as the ASR model returned it.',
            },
            model: { type: 'string' },
            requestId: { type: 'string' },
            language: { type: 'string' },
            emotion: { type: 'string' },
            audioSeconds: { type: 'number' },
            raw: {
              description: 'Complete raw JSON response returned by the Qwen API.',
            },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: `Transcript:\n${value.text}` },
          {
            type: 'text',
            text: `Raw Qwen API output:\n\`\`\`json\n${renderRawOutput(value.raw)}\n\`\`\``,
          },
        ],
      },
      async execute(args, exec) {
        const config = currentConfig();
        const signal = exec?.signal;
        const path = resolveAudioPath(args.path, exec, service('workingDirectory'));
        if (!isAudioName(path, config.audioExtensions)) {
          throw new Error(`Not a recognized audio file: ${path}`);
        }
        const bytes = await readAudioFileBytes(path, config, signal);
        const override = {};
        if (typeof args.language === 'string' && args.language !== '' && args.language !== 'auto') {
          override.language = args.language;
        }
        if (typeof args.enable_itn === 'boolean') override.enableItn = args.enable_itn;
        return await transcribeBytes(config, bytes, basename(path), signal, override);
      },
    }),
  );
}
