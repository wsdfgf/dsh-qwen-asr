/**
 * Qwen ASR client for the dsh-qwen-asr bundle.
 *
 * Two DashScope APIs are supported:
 *
 * 1. `filetrans` (default) — asynchronous long-audio transcription
 *    (`qwen3-asr-flash-filetrans`). A local file is first published to
 *    DashScope's temporary OSS storage, then a transcription task is submitted,
 *    polled, and its result JSON downloaded. Limits: ≤ 2 GB / ≤ 12 h per the
 *    model, ≤ 1 GB through the temporary-upload API.
 *
 *    upload: GET  {base}/api/v1/uploads?action=getPolicy&model=<model>
 *            POST {upload_host} (multipart)
 *    submit: POST {base}/api/v1/services/audio/asr/transcription
 *            headers X-DashScope-Async: enable, X-DashScope-OssResourceResolve: enable
 *    poll:   GET  {base}/api/v1/tasks/{task_id}
 *    result: GET  output.result.transcription_url
 *
 * 2. `sync` — OpenAI-compatible inline transcription (`qwen3-asr-flash`), for
 *    short clips only: ≤ 10 MB of base64 (≈ 7.5 MB raw) and ≤ 5 minutes.
 *
 * This module is deliberately free of Cordis imports: it only needs Node
 * built-ins, so the transcription paths can be exercised by a plain Node test
 * script before the bundle is installed into a DSH profile.
 */

import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

/** Language hints accepted by the Qwen ASR models; `auto` omits the hint. */
export const LANGUAGES = [
  'auto',
  'zh',
  'yue',
  'en',
  'ja',
  'ko',
  'de',
  'ru',
  'fr',
  'pt',
  'ar',
  'it',
  'es',
  'hi',
  'id',
  'th',
  'tr',
  'uk',
  'vi',
  'cs',
  'da',
  'fil',
  'fi',
  'is',
  'ms',
  'no',
  'pl',
  'sv',
];

/** File extensions treated as audio when an attachment is auto-transcribed. */
export const DEFAULT_AUDIO_EXTENSIONS = [
  'mp3',
  'wav',
  'm4a',
  'm4b',
  'aac',
  'ogg',
  'oga',
  'opus',
  'flac',
  'amr',
  'webm',
  'wma',
  'aiff',
  'aif',
  'caf',
  '3gp',
  'mp4',
];

const AUDIO_MIME = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  amr: 'audio/amr',
  webm: 'audio/webm',
  wma: 'audio/x-ms-wma',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  caf: 'audio/x-caf',
  '3gp': 'audio/3gpp',
};

/** Settings defaults; the plugin's Config schema mirrors these. */
export const DEFAULTS = {
  apiKey: '',
  apiKeyEnv: 'DASHSCOPE_API_KEY',
  /** `filetrans` (long audio, async) or `sync` (short inline clip). */
  api: 'filetrans',
  /** Async long-audio model; accepts DashScope temporary `oss://` uploads. */
  model: 'qwen3-asr-flash-filetrans',
  /** Synchronous model used only when `api` is `sync`. */
  syncModel: 'qwen3-asr-flash',
  /** OpenAI-compatible base URL for the sync API. */
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  /** DashScope native base URL for uploads, async tasks, and task queries. */
  dashscopeBaseURL: 'https://dashscope.aliyuncs.com',
  language: 'auto',
  enableItn: false,
  enableWords: false,
  autoTranscribe: true,
  injectRawOutput: false,
  /** Sync-mode inline audio limit in raw bytes (≈ 7.5 MB keeps Base64 ≤ 10 MB). */
  maxAudioBytes: 7_000_000,
  /** Async-mode upload limit in raw bytes; DashScope's temporary upload caps at 1 GB. */
  maxFileBytes: 1_000_000_000,
  timeoutMs: 120_000,
  uploadTimeoutMs: 600_000,
  taskTimeoutMs: 900_000,
  pollIntervalMs: 3_000,
  audioExtensions: DEFAULT_AUDIO_EXTENSIONS,
};

/** Hard cap on transcript characters injected into the model request. */
const MAX_INJECTED_CHARS = 20_000;
/** Hard cap on raw-response characters injected into the model request. */
const MAX_INJECTED_RAW_CHARS = 4_000;
/** Hard cap on raw-response characters rendered by the tool result. */
const MAX_RENDERED_RAW_CHARS = 8_000;

/**
 * Coerce arbitrary plugin config into a complete, typed configuration.
 * Unknown or malformed values fall back to the documented default.
 *
 * Editable settings fields are marked `volatile` in the plugin Config so DSH
 * renders a settings form for them; such fields arrive as `{ get() }` references
 * rather than plain values, so each is read through `read()`.
 * @param {object | undefined} config raw Loader config object.
 * @returns complete configuration.
 */
export function normalizeConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {};
  const read = (key) => {
    const value = source[key];
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
      try {
        return value.get();
      } catch {
        return undefined;
      }
    }
    return value;
  };
  const str = (value, fallback) =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
  const positive = (value, fallback) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

  const apiKey = read('apiKey');
  const rawLanguage = str(read('language'), DEFAULTS.language);
  const language = LANGUAGES.includes(rawLanguage) ? rawLanguage : DEFAULTS.language;
  const rawExtensions = read('audioExtensions');
  const extensionList = Array.isArray(rawExtensions)
    ? rawExtensions
        .map((value) => String(value).trim().toLowerCase().replace(/^\./, ''))
        .filter((value) => value !== '')
    : [];
  const rawApi = str(read('api'), DEFAULTS.api).toLowerCase();
  const api = rawApi === 'sync' ? 'sync' : 'filetrans';

  return {
    apiKey: typeof apiKey === 'string' ? apiKey.trim() : DEFAULTS.apiKey,
    apiKeyEnv: str(read('apiKeyEnv'), DEFAULTS.apiKeyEnv),
    api,
    model: str(read('model'), DEFAULTS.model),
    syncModel: str(read('syncModel'), DEFAULTS.syncModel),
    baseURL: str(read('baseURL'), DEFAULTS.baseURL),
    dashscopeBaseURL: str(read('dashscopeBaseURL'), DEFAULTS.dashscopeBaseURL),
    language,
    enableItn: bool(read('enableItn'), DEFAULTS.enableItn),
    enableWords: bool(read('enableWords'), DEFAULTS.enableWords),
    autoTranscribe: bool(read('autoTranscribe'), DEFAULTS.autoTranscribe),
    injectRawOutput: bool(read('injectRawOutput'), DEFAULTS.injectRawOutput),
    maxAudioBytes: positive(read('maxAudioBytes'), DEFAULTS.maxAudioBytes),
    maxFileBytes: positive(read('maxFileBytes'), DEFAULTS.maxFileBytes),
    timeoutMs: positive(read('timeoutMs'), DEFAULTS.timeoutMs),
    uploadTimeoutMs: positive(read('uploadTimeoutMs'), DEFAULTS.uploadTimeoutMs),
    taskTimeoutMs: positive(read('taskTimeoutMs'), DEFAULTS.taskTimeoutMs),
    pollIntervalMs: positive(read('pollIntervalMs'), DEFAULTS.pollIntervalMs),
    audioExtensions: extensionList.length > 0 ? extensionList : DEFAULT_AUDIO_EXTENSIONS,
  };
}

/**
 * Resolve the DashScope API key: explicit config first, then the configured
 * environment variable, then the two conventional Qwen key names.
 * @param {object} config normalized configuration.
 * @param {Record<string, string | undefined>} [env] environment to read.
 * @returns the key, or undefined when no source provides one.
 */
export function resolveApiKey(config, env = process.env) {
  if (typeof config.apiKey === 'string' && config.apiKey.trim() !== '') return config.apiKey.trim();
  for (const name of [config.apiKeyEnv, 'DASHSCOPE_API_KEY', 'QWEN_API_KEY']) {
    const value = env?.[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/** Lowercase extension without the dot; `''` when the name has none. */
export function extensionOf(name) {
  if (typeof name !== 'string') return '';
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Whether a file name looks like audio this plugin can transcribe.
 * @param {unknown} name display name of a file or attachment.
 * @param {readonly string[]} [extensions] accepted extensions.
 * @returns true for accepted audio names.
 */
export function isAudioName(name, extensions = DEFAULT_AUDIO_EXTENSIONS) {
  const ext = extensionOf(name);
  return ext !== '' && extensions.includes(ext);
}

/** MIME type sent in the base64 data URI for a known audio extension. */
export function mimeForAudio(name) {
  return AUDIO_MIME[extensionOf(name)] ?? 'application/octet-stream';
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function trimBase(url) {
  return url.replace(/\/+$/, '');
}

function authHeaders(config, apiKey) {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  };
}

function requireApiKey(config) {
  const apiKey = resolveApiKey(config);
  if (apiKey === undefined) {
    throw new Error(
      `No Qwen API key is configured. Set the ${config.apiKeyEnv} environment variable ` +
        '(or the plugin apiKey setting) to a DashScope API key.',
    );
  }
  return apiKey;
}

function abortError(signal, timeout) {
  if (signal?.aborted) {
    const reason = signal.reason;
    return reason instanceof Error ? reason : new Error('Qwen ASR transcription was cancelled');
  }
  return new Error(`Qwen ASR request timed out after ${timeout} ms`);
}

function describeError(error) {
  if (error instanceof Error) {
    if (error.cause instanceof Error && error.cause.message !== error.message) {
      return `${error.message}: ${error.cause.message}`;
    }
    return error.message;
  }
  return String(error);
}

function timeoutSignal(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error('Cancelled'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Read a response body and parse it, keeping the raw text for diagnostics. */
async function readJsonResponse(response, signal, timeout) {
  let text;
  try {
    text = await response.text();
  } catch (error) {
    if (signal?.aborted) throw abortError(signal, timeout);
    throw new Error(`Qwen ASR response could not be read: ${describeError(error)}`);
  }
  let parsed;
  let parseError;
  try {
    parsed = text === '' ? undefined : JSON.parse(text);
  } catch (error) {
    parsed = undefined;
    parseError = error;
  }
  return { text, parsed, parseError };
}

function failureDetail(parsed, text, parseError) {
  return (
    (typeof parsed?.error?.message === 'string' && parsed.error.message) ||
    (typeof parsed?.message === 'string' && parsed.message) ||
    (typeof parsed?.code === 'string' && parsed.code) ||
    (typeof parsed?.output?.code === 'string' && parsed.output.code) ||
    (parseError !== undefined ? text.slice(0, 300) : '')
  );
}

/* ------------------------------------------------------------------ */
/* Synchronous inline API (`qwen3-asr-flash`)                          */
/* ------------------------------------------------------------------ */

function chatEndpoint(baseURL) {
  return `${trimBase(baseURL)}/chat/completions`;
}

/**
 * Build the exact request body sent to the OpenAI-compatible API.
 * @param {object} config normalized configuration.
 * @param {string} name file name used to pick the MIME type.
 * @param {Uint8Array} bytes audio bytes.
 * @returns JSON body.
 */
export function buildAsrRequest(config, name, bytes) {
  const options = { enable_itn: config.enableItn === true };
  if (config.language !== 'auto') options.language = config.language;
  return {
    model: config.syncModel,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'input_audio',
            input_audio: {
              data: `data:${mimeForAudio(name)};base64,${Buffer.from(bytes).toString('base64')}`,
            },
          },
        ],
      },
    ],
    stream: false,
    asr_options: options,
  };
}

/**
 * Extract the transcript and annotations from one raw sync API response.
 * @param {unknown} raw parsed JSON response.
 * @param {object} config normalized configuration.
 * @returns canonical transcription value.
 */
export function parseAsrResponse(raw, config) {
  const record = raw !== null && typeof raw === 'object' ? raw : undefined;
  const choice = record?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('Qwen ASR returned an unexpected response without choices[0].message.content');
  }
  const annotations = Array.isArray(choice?.message?.annotations)
    ? choice.message.annotations
    : [];
  const info = annotations.find((item) => item?.type === 'audio_info') ?? annotations[0];
  return {
    text: content,
    model: typeof record?.model === 'string' ? record.model : config.syncModel,
    requestId: typeof record?.id === 'string' ? record.id : undefined,
    language: typeof info?.language === 'string' ? info.language : undefined,
    emotion: typeof info?.emotion === 'string' ? info.emotion : undefined,
    audioSeconds:
      typeof record?.usage?.seconds === 'number' ? record.usage.seconds : undefined,
    raw,
  };
}

/**
 * Transcribe one short clip through the OpenAI-compatible inline API.
 * @param {object} options
 * @param {Uint8Array} options.bytes audio bytes.
 * @param {string} options.name file name; selects the data-URI MIME type.
 * @param {object} options.config normalized configuration.
 * @param {AbortSignal} [options.signal] caller cancellation.
 * @param {typeof fetch} [options.fetchImpl] injectable transport for tests.
 * @returns transcript value including `raw`.
 */
export async function transcribeSync({ bytes, name, config, signal, fetchImpl = fetch }) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error('The audio file is empty');
  }
  if (bytes.byteLength > config.maxAudioBytes) {
    throw new Error(
      `Audio is ${bytes.byteLength} bytes, above the sync limit of ${config.maxAudioBytes} bytes; ` +
        'the Qwen inline API accepts at most 10 MB of base64-encoded audio (about 7.5 MB raw) and 5 minutes',
    );
  }
  const apiKey = requireApiKey(config);
  const timeout = timeoutSignal(signal, config.timeoutMs);

  let response;
  try {
    response = await fetchImpl(chatEndpoint(config.baseURL), {
      method: 'POST',
      headers: authHeaders(config, apiKey),
      body: JSON.stringify(buildAsrRequest(config, name, bytes)),
      signal: timeout,
    });
  } catch (error) {
    if (timeout.aborted) throw abortError(signal, config.timeoutMs);
    throw new Error(`Qwen ASR request failed: ${describeError(error)}`);
  }

  const { text, parsed, parseError } = await readJsonResponse(response, timeout, config.timeoutMs);
  if (!response.ok) {
    const detail = failureDetail(parsed, text, parseError);
    throw new Error(
      `Qwen ASR API returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
    );
  }
  if (parsed === undefined) {
    throw new Error(
      `Qwen ASR returned a non-JSON response: ${text.slice(0, 300) || '(empty body)'}`,
    );
  }
  return parseAsrResponse(parsed, config);
}

/* ------------------------------------------------------------------ */
/* Asynchronous filetrans API (`qwen3-asr-flash-filetrans`)            */
/* ------------------------------------------------------------------ */

function uploadPolicyEndpoint(config) {
  const base = trimBase(config.dashscopeBaseURL);
  return `${base}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(config.model)}`;
}

function transcriptionEndpoint(config) {
  return `${trimBase(config.dashscopeBaseURL)}/api/v1/services/audio/asr/transcription`;
}

function taskEndpoint(config, taskId) {
  return `${trimBase(config.dashscopeBaseURL)}/api/v1/tasks/${encodeURIComponent(taskId)}`;
}

/**
 * Ask DashScope for temporary upload credentials.
 * @param {object} config normalized configuration.
 * @param {string} apiKey DashScope API key.
 * @param {AbortSignal | undefined} signal cancellation.
 * @param {typeof fetch} fetchImpl transport.
 * @returns policy `data` object.
 */
export async function requestUploadPolicy({ config, apiKey, signal, fetchImpl = fetch }) {
  const timeout = timeoutSignal(signal, config.timeoutMs);
  let response;
  try {
    response = await fetchImpl(uploadPolicyEndpoint(config), {
      method: 'GET',
      headers: authHeaders(config, apiKey),
      signal: timeout,
    });
  } catch (error) {
    if (timeout.aborted) throw abortError(signal, config.timeoutMs);
    throw new Error(`Qwen temporary-upload policy request failed: ${describeError(error)}`);
  }
  const { text, parsed } = await readJsonResponse(response, timeout, config.timeoutMs);
  if (!response.ok) {
    throw new Error(
      `Qwen temporary-upload policy returned HTTP ${response.status}${
        text ? `: ${text.slice(0, 300)}` : ''
      }`,
    );
  }
  const data = parsed?.data;
  if (data === null || typeof data !== 'object' || typeof data.upload_host !== 'string') {
    throw new Error('Qwen temporary-upload policy response is missing data.upload_host');
  }
  return data;
}

/**
 * Publish one local audio buffer to DashScope's temporary OSS storage.
 * @param {object} options
 * @param {Uint8Array} options.bytes audio bytes.
 * @param {string} options.name original file name (used for the object key).
 * @param {object} options.config normalized configuration.
 * @param {AbortSignal} [options.signal] cancellation.
 * @param {typeof fetch} [options.fetchImpl] transport.
 * @returns `oss://` URL usable by the async transcription API.
 */
export async function uploadAudio({ bytes, name, config, signal, fetchImpl = fetch }) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error('The audio file is empty');
  }
  if (bytes.byteLength > config.maxFileBytes) {
    throw new Error(
      `Audio is ${bytes.byteLength} bytes, above the configured limit of ${config.maxFileBytes} bytes`,
    );
  }
  const apiKey = requireApiKey(config);
  const policy = await requestUploadPolicy({ config, apiKey, signal, fetchImpl });
  const declaredLimit = Number(policy.max_file_size_mb);
  if (Number.isFinite(declaredLimit) && declaredLimit > 0 && bytes.byteLength > declaredLimit * 1024 * 1024) {
    throw new Error(
      `Audio is ${bytes.byteLength} bytes, above the DashScope temporary-upload limit of ` +
        `${declaredLimit} MB for model ${config.model}`,
    );
  }

  const safeName = basename(typeof name === 'string' && name !== '' ? name : 'audio');
  const key = `${policy.upload_dir}/${Date.now().toString(36)}-${randomUUID().slice(0, 8)}-${safeName}`;
  const form = new FormData();
  form.append('OSSAccessKeyId', String(policy.oss_access_key_id ?? ''));
  form.append('Signature', String(policy.signature ?? ''));
  form.append('policy', String(policy.policy ?? ''));
  form.append('x-oss-object-acl', String(policy.x_oss_object_acl ?? 'private'));
  form.append('x-oss-forbid-overwrite', String(policy.x_oss_forbid_overwrite ?? 'true'));
  form.append('key', key);
  form.append('success_action_status', '200');
  form.append('file', new Blob([bytes], { type: mimeForAudio(safeName) }), safeName);

  const uploadTimeout = timeoutSignal(signal, config.uploadTimeoutMs);
  let response;
  try {
    response = await fetchImpl(String(policy.upload_host), {
      method: 'POST',
      body: form,
      signal: uploadTimeout,
    });
  } catch (error) {
    if (uploadTimeout.aborted) throw abortError(signal, config.uploadTimeoutMs);
    throw new Error(`Qwen temporary upload failed: ${describeError(error)}`);
  }
  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      // ignore an unreadable error body
    }
    throw new Error(
      `Qwen temporary upload returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
    );
  }
  return `oss://${key}`;
}

/**
 * The async submit body's `input` object. Qwen3-ASR-Filetrans takes a single
 * `file_url`; the Qwen-Audio / Fun-ASR / Paraformer async models take
 * `file_urls`.
 * @param {string} model async model id.
 * @param {string} ossURL temporary or public audio URL.
 * @returns submit input object.
 */
export function filetransInput(model, ossURL) {
  return /^qwen3-asr/i.test(String(model))
    ? { file_url: ossURL }
    : { file_urls: [ossURL] };
}

/**
 * Async submit parameters for the configured model family.
 * @param {object} config normalized configuration.
 * @returns parameters object.
 */
export function filetransParameters(config) {
  const parameters = { channel_id: [0] };
  const qwen3 = /^qwen3-asr/i.test(config.model);
  if (config.language !== 'auto') {
    if (qwen3) parameters.language = config.language;
    else parameters.language_hints = [config.language];
  }
  if (qwen3) {
    parameters.enable_itn = config.enableItn === true;
    parameters.enable_words = config.enableWords === true;
  }
  return parameters;
}

/**
 * Find the first `transcription_url` string anywhere in a task query response;
 * the async model families nest it under different keys.
 * @param {unknown} root task query response.
 * @returns the URL, or undefined.
 */
export function findTranscriptionUrl(root) {
  const stack = [root];
  const seen = new Set();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'transcription_url' && typeof value === 'string' && value !== '') return value;
      if (value !== null && typeof value === 'object') stack.push(value);
    }
  }
  return undefined;
}

/**
 * Submit an async transcription task for one `oss://` file.
 * @param {object} options
 * @param {string} options.ossURL temporary URL returned by {@link uploadAudio}.
 * @param {object} options.config normalized configuration.
 * @param {AbortSignal} [options.signal] cancellation.
 * @param {typeof fetch} [options.fetchImpl] transport.
 * @returns submission response.
 */
export async function submitFiletrans({ ossURL, config, signal, fetchImpl = fetch }) {
  const apiKey = requireApiKey(config);
  const body = {
    model: config.model,
    input: filetransInput(config.model, ossURL),
    parameters: filetransParameters(config),
  };
  const timeout = timeoutSignal(signal, config.timeoutMs);

  let response;
  try {
    response = await fetchImpl(transcriptionEndpoint(config), {
      method: 'POST',
      headers: {
        ...authHeaders(config, apiKey),
        'x-dashscope-async': 'enable',
        // Exact name the gateway expects (lower-cased form of
        // X-DashScope-OssResourceResolve); an extra hyphen breaks resolution.
        'x-dashscope-ossresourceresolve': 'enable',
      },
      body: JSON.stringify(body),
      signal: timeout,
    });
  } catch (error) {
    if (timeout.aborted) throw abortError(signal, config.timeoutMs);
    throw new Error(`Qwen filetrans submit failed: ${describeError(error)}`);
  }
  const { text, parsed, parseError } = await readJsonResponse(response, timeout, config.timeoutMs);
  if (!response.ok) {
    const detail = failureDetail(parsed, text, parseError);
    throw new Error(
      `Qwen filetrans submit returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
    );
  }
  const taskId = parsed?.output?.task_id;
  if (typeof taskId !== 'string' || taskId === '') {
    throw new Error('Qwen filetrans submit response is missing output.task_id');
  }
  return parsed;
}

/**
 * Poll one async transcription task until it settles.
 * @param {object} options
 * @param {string} options.taskId submit response `output.task_id`.
 * @param {object} options.config normalized configuration.
 * @param {AbortSignal} [options.signal] cancellation.
 * @param {typeof fetch} [options.fetchImpl] transport.
 * @returns settled task query response.
 */
export async function waitFiletrans({ taskId, config, signal, fetchImpl = fetch }) {
  const apiKey = requireApiKey(config);
  const deadline = Date.now() + config.taskTimeoutMs;
  for (;;) {
    signal?.throwIfAborted?.();
    const timeout = timeoutSignal(signal, config.timeoutMs);
    let response;
    try {
      response = await fetchImpl(taskEndpoint(config, taskId), {
        method: 'GET',
        headers: authHeaders(config, apiKey),
        signal: timeout,
      });
    } catch (error) {
      if (timeout.aborted) throw abortError(signal, config.timeoutMs);
      throw new Error(`Qwen filetrans task query failed: ${describeError(error)}`);
    }
    const { text, parsed, parseError } = await readJsonResponse(response, timeout, config.timeoutMs);
    if (!response.ok) {
      const detail = failureDetail(parsed, text, parseError);
      throw new Error(
        `Qwen filetrans task query returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
      );
    }
    const status = parsed?.output?.task_status;
    if (status === 'SUCCEEDED') return parsed;
    if (status === 'FAILED' || status === 'UNKNOWN') {
      const detail = failureDetail(parsed, text, parseError);
      throw new Error(
        `Qwen filetrans task ${taskId} ${status === 'UNKNOWN' ? 'no longer exists' : 'failed'}` +
          (detail ? `: ${detail}` : ''),
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Qwen filetrans task ${taskId} did not finish within ${config.taskTimeoutMs} ms ` +
          `(last status: ${String(status ?? 'unknown')})`,
      );
    }
    await sleep(config.pollIntervalMs, signal);
  }
}

/**
 * Download and parse one finished task's transcription result JSON.
 * @param {object} options
 * @param {string} options.url signed `transcription_url`.
 * @param {object} options.config normalized configuration.
 * @param {AbortSignal} [options.signal] cancellation.
 * @param {typeof fetch} [options.fetchImpl] transport.
 * @returns parsed transcription result.
 */
export async function downloadTranscription({ url, config, signal, fetchImpl = fetch }) {
  const timeout = timeoutSignal(signal, config.timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', signal: timeout });
  } catch (error) {
    if (timeout.aborted) throw abortError(signal, config.timeoutMs);
    throw new Error(`Qwen transcription result download failed: ${describeError(error)}`);
  }
  const { text, parsed } = await readJsonResponse(response, timeout, config.timeoutMs);
  if (!response.ok) {
    throw new Error(
      `Qwen transcription result download returned HTTP ${response.status}${
        text ? `: ${text.slice(0, 300)}` : ''
      }`,
    );
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('Qwen transcription result is not a JSON object');
  }
  return parsed;
}

/**
 * Extract the canonical transcription value from a filetrans result.
 * @param {object} transcription downloaded result JSON.
 * @param {object} config normalized configuration.
 * @param {{ submit?: object, task?: object }} meta task envelopes.
 * @returns canonical transcription value.
 */
export function parseFiletransResult(transcription, config, meta = {}) {
  const transcripts = Array.isArray(transcription?.transcripts) ? transcription.transcripts : [];
  const text = transcripts
    .map((entry) => (typeof entry?.text === 'string' ? entry.text : ''))
    .filter((entry) => entry !== '')
    .join('\n');
  if (text === '' && transcripts.length === 0) {
    throw new Error('Qwen filetrans result contains no transcripts');
  }
  const firstChannel = transcripts[0];
  const firstSentence = Array.isArray(firstChannel?.sentences) ? firstChannel.sentences[0] : undefined;
  const durationMs = Number(transcription?.properties?.original_duration_in_milliseconds);
  const taskSeconds = Number(meta.task?.usage?.seconds);
  return {
    text,
    model: config.model,
    requestId:
      typeof meta.submit?.request_id === 'string' ? meta.submit.request_id : undefined,
    language:
      typeof firstSentence?.language === 'string' ? firstSentence.language : undefined,
    emotion: typeof firstSentence?.emotion === 'string' ? firstSentence.emotion : undefined,
    audioSeconds: Number.isFinite(durationMs) && durationMs > 0
      ? durationMs / 1000
      : Number.isFinite(taskSeconds) && taskSeconds > 0
        ? taskSeconds
        : undefined,
    raw: {
      submit: meta.submit,
      task: meta.task,
      transcription,
    },
  };
}

/**
 * Transcribe one audio buffer through the async filetrans pipeline:
 * temporary upload → submit → poll → download result.
 * @param {object} options
 * @param {Uint8Array} options.bytes audio bytes.
 * @param {string} options.name file name.
 * @param {object} options.config normalized configuration.
 * @param {AbortSignal} [options.signal] cancellation.
 * @param {typeof fetch} [options.fetchImpl] transport.
 * @returns canonical transcription value.
 */
export async function transcribeFiletrans({ bytes, name, config, signal, fetchImpl = fetch }) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error('The audio file is empty');
  }
  if (bytes.byteLength > config.maxFileBytes) {
    throw new Error(
      `Audio is ${bytes.byteLength} bytes, above the configured limit of ${config.maxFileBytes} bytes`,
    );
  }
  const ossURL = await uploadAudio({ bytes, name, config, signal, fetchImpl });
  const submit = await submitFiletrans({ ossURL, config, signal, fetchImpl });
  const task = await waitFiletrans({ taskId: submit.output.task_id, config, signal, fetchImpl });
  const transcriptionURL = findTranscriptionUrl(task);
  if (transcriptionURL === undefined) {
    throw new Error('Qwen filetrans task succeeded without a transcription_url');
  }
  const transcription = await downloadTranscription({
    url: transcriptionURL,
    config,
    signal,
    fetchImpl,
  });
  return parseFiletransResult(transcription, config, { submit, task });
}

/**
 * Transcribe one audio buffer with the configured API mode.
 * @param {object} options
 * @param {Uint8Array} options.bytes audio bytes.
 * @param {string} options.name file name.
 * @param {object} options.config normalized configuration.
 * @param {AbortSignal} [options.signal] cancellation.
 * @param {typeof fetch} [options.fetchImpl] transport.
 * @returns canonical transcription value.
 */
export async function transcribeAudio({ bytes, name, config, signal, fetchImpl = fetch }) {
  if (config.api === 'sync') {
    return transcribeSync({ bytes, name, config, signal, fetchImpl });
  }
  return transcribeFiletrans({ bytes, name, config, signal, fetchImpl });
}

/**
 * Read one audio file from disk, enforcing the active mode's size bound.
 * @param {string} path absolute path.
 * @param {object} config normalized configuration.
 * @param {AbortSignal} [signal] caller cancellation.
 * @returns audio bytes.
 */
export async function readAudioFileBytes(path, config, signal) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Not a regular file: ${path}`);
  if (info.size === 0) throw new Error(`The audio file is empty: ${path}`);
  const limit = config.api === 'sync' ? config.maxAudioBytes : config.maxFileBytes;
  if (info.size > limit) {
    throw new Error(
      config.api === 'sync'
        ? `The audio file is ${info.size} bytes, above the sync limit of ${limit} bytes; ` +
            'the inline Qwen API accepts at most 10 MB of base64-encoded audio and 5 minutes'
        : `The audio file is ${info.size} bytes, above the configured limit of ${limit} bytes`,
    );
  }
  return new Uint8Array(await readFile(path, { signal }));
}

/**
 * Model-facing text appended after an uploaded audio file's handle. Keeps the
 * attachment identity so the model can correlate it with the saved path.
 * Long transcripts and raw envelopes are truncated so one long recording
 * cannot flood the request; the full text stays available through the tool.
 * @param {{ name?: unknown, bytes?: unknown }} ref durable attachment reference.
 * @param {object} value canonical transcription value.
 * @param {boolean} includeRaw whether to append the raw JSON response.
 * @returns text block content.
 */
export function formatTranscriptInjection(ref, value, includeRaw) {
  const name = typeof ref?.name === 'string' ? ref.name : 'audio';
  const size = typeof ref?.bytes === 'number' ? `, ${ref.bytes} bytes` : '';
  const language = value.language ? `, language: ${value.language}` : '';
  let text = typeof value.text === 'string' ? value.text : '';
  const lines = [
    `[Qwen ASR transcript of uploaded audio ${JSON.stringify(name)}${size}${language} (model: ${value.model})]:`,
  ];
  if (text.length > MAX_INJECTED_CHARS) {
    lines.push(
      `${text.slice(0, MAX_INJECTED_CHARS)}`,
      `[… transcript truncated after ${MAX_INJECTED_CHARS} characters; call qwen_transcribe_audio for the full text …]`,
    );
  } else {
    lines.push(text);
  }
  lines.push('End of Qwen ASR transcript.');
  if (includeRaw) {
    const raw = JSON.stringify(value.raw, null, 2);
    lines.push(
      '',
      'Raw Qwen ASR response' +
        (raw.length > MAX_INJECTED_RAW_CHARS ? ` (truncated after ${MAX_INJECTED_RAW_CHARS} characters)` : '') +
        ':',
      '```json',
      raw.length > MAX_INJECTED_RAW_CHARS ? `${raw.slice(0, MAX_INJECTED_RAW_CHARS)}\n…` : raw,
      '```',
    );
  }
  return lines.join('\n');
}

/**
 * Text appended when transcription fails, so the model reports the limitation
 * instead of guessing what the audio said.
 * @param {{ name?: unknown }} ref durable attachment reference.
 * @param {unknown} error failure.
 * @returns text block content.
 */
export function formatTranscriptFailure(ref, error) {
  const name = typeof ref?.name === 'string' ? ref.name : 'the audio attachment';
  const reason = error instanceof Error ? error.message : String(error);
  return (
    `[Qwen ASR could not transcribe ${JSON.stringify(name)}: ${reason}. ` +
    'The audio content is unavailable; tell the user if it matters.]'
  );
}

/**
 * Render the raw API output for a tool result, bounded so one long recording
 * cannot flood the model context.
 * @param {unknown} raw canonical `raw` field.
 * @param {number} [maxChars] character budget.
 * @returns bounded pretty JSON text.
 */
export function renderRawOutput(raw, maxChars = MAX_RENDERED_RAW_CHARS) {
  const json = JSON.stringify(raw, null, 2);
  if (typeof json !== 'string') return '(no raw output)';
  if (json.length <= maxChars) return json;
  return `${json.slice(0, maxChars)}\n… (raw output truncated at ${maxChars} characters)`;
}
