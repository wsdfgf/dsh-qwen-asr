/**
 * Browser half of dsh-qwen-asr.
 *
 * Registers the bundle row's configuration page (`plugins.row.config`, keyed by
 * `<package name>#<row id>`) so the Plugins page shows a Configure control for
 * the `qwen-asr` row. The page hands us `{ view, form }`, where `form` is the
 * Host settings form: `state` is `{ value, base, user, revision, writable }` and
 * `mutate(ops, revision)` writes `{ op: 'set', path: [field], value }` entries.
 */
window.__ModuleLoader__.load({
  id: 'dsh-qwen-asr',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const NS = 'qwenAsr';
    const ROW_CONFIG_KEY = 'dsh-qwen-asr#qwen-asr';

    const zh = {
      title: '千问语音转文字',
      intro:
        '上传音频文件后自动转写。默认使用异步长音频接口：先把本地文件临时上传到百炼，再提交任务并轮询结果，单文件最大 1 GB。填写 DashScope API Key 后点保存；Key 留空时会读取环境变量。',
      summary: '配置 DashScope API Key 与异步转写选项',
      apiKey: 'API Key',
      apiKeyHint: '留空时读取环境变量 DASHSCOPE_API_KEY / QWEN_API_KEY；也可写成 sk-…',
      api: '转写接口',
      apiHint: 'filetrans：异步长音频（≤1GB、≤12小时）；sync：同步短音频（≤10MB、≤5分钟）',
      model: '异步模型',
      modelHint: '默认 qwen3-asr-flash-filetrans；也支持 qwen-audio-3.1-asr-flash-filetrans 等异步模型',
      dashscopeBaseURL: '异步接口地址',
      language: '语言提示',
      languageHint: 'auto 表示自动识别，也可填 zh、en、yue、ja 等',
      autoTranscribe: '上传音频时自动转写',
      enableItn: '数字规范化（仅中英文）',
      injectRawOutput: '自动转写时附带原始 JSON',
      maxFileBytes: '文件大小上限（字节）',
      taskTimeoutMs: '异步任务等待超时（毫秒）',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      unchanged: '没有改动',
      failed: '保存失败，请检查后重试',
      loading: '正在读取配置…',
      readonly: '当前配置不可写入',
      unavailable: '该插件行没有可编辑的配置。',
    };

    const en = {
      title: 'Qwen Speech-to-Text',
      intro:
        'Uploaded audio is transcribed automatically. By default the async long-audio API is used: the local file is published to DashScope temporary storage, then a task is submitted and polled (up to 1 GB per file). Enter a DashScope API key and save; leave it empty to read the environment.',
      summary: 'Configure the DashScope API key and async transcription options',
      apiKey: 'API key',
      apiKeyHint: 'Leave empty to use DASHSCOPE_API_KEY / QWEN_API_KEY; usually starts with sk-',
      api: 'Transcription API',
      apiHint: 'filetrans: async long audio (≤1 GB, ≤12 h); sync: inline short audio (≤10 MB, ≤5 min)',
      model: 'Async model',
      modelHint:
        'Defaults to qwen3-asr-flash-filetrans; qwen-audio-3.1-asr-flash-filetrans and other async models also work',
      dashscopeBaseURL: 'Async endpoint',
      language: 'Language hint',
      languageHint: 'auto detects the language; zh, en, yue, ja and more are accepted',
      autoTranscribe: 'Transcribe uploaded audio automatically',
      enableItn: 'Inverse text normalization (Chinese and English)',
      injectRawOutput: 'Include the raw JSON when auto-transcribing',
      maxFileBytes: 'Max file bytes',
      taskTimeoutMs: 'Async task timeout (ms)',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      unchanged: 'No changes',
      failed: 'Save failed; check the values and retry',
      loading: 'Reading configuration…',
      readonly: 'This configuration is not writable',
      unavailable: 'This plugin row has no editable configuration.',
    };

    const DEFAULTS = {
      apiKey: '',
      api: 'filetrans',
      model: 'qwen3-asr-flash-filetrans',
      dashscopeBaseURL: 'https://dashscope.aliyuncs.com',
      language: 'auto',
      autoTranscribe: true,
      enableItn: false,
      injectRawOutput: false,
      maxFileBytes: 1000000000,
      taskTimeoutMs: 900000,
    };

    const FIELDS = [
      { key: 'apiKey', kind: 'secret', label: 'apiKey', hint: 'apiKeyHint' },
      { key: 'api', kind: 'text', label: 'api', hint: 'apiHint' },
      { key: 'model', kind: 'text', label: 'model', hint: 'modelHint' },
      { key: 'dashscopeBaseURL', kind: 'text', label: 'dashscopeBaseURL' },
      { key: 'language', kind: 'text', label: 'language', hint: 'languageHint' },
      { key: 'autoTranscribe', kind: 'boolean', label: 'autoTranscribe' },
      { key: 'enableItn', kind: 'boolean', label: 'enableItn' },
      { key: 'injectRawOutput', kind: 'boolean', label: 'injectRawOutput' },
      { key: 'maxFileBytes', kind: 'number', label: 'maxFileBytes' },
      { key: 'taskTimeoutMs', kind: 'number', label: 'taskTimeoutMs' },
    ];

    const styles = {
      section: { display: 'grid', gap: 14, padding: '6px 0', maxWidth: 640 },
      heading: { margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      intro: { margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
      label: { display: 'grid', gap: 4 },
      labelText: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 13,
      },
      check: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--dsw-alias-label-primary)' },
      hint: { margin: 0, fontSize: 11, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
      actions: { display: 'flex', alignItems: 'center', gap: 12 },
      button: {
        padding: '6px 16px',
        borderRadius: 8,
        border: '1px solid transparent',
        background: 'var(--dsw-alias-brand-primary)',
        color: '#fff',
        font: 'inherit',
        fontSize: 13,
        cursor: 'pointer',
      },
      notice: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
    };

    function readValues(form) {
      const source = form && form.state && form.state.value ? form.state.value : {};
      const values = {};
      for (const field of FIELDS) {
        const value = source[field.key];
        values[field.key] = value === undefined || value === null ? DEFAULTS[field.key] : value;
      }
      return values;
    }

    function same(a, b) {
      if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
      return a === b || JSON.stringify(a) === JSON.stringify(b);
    }

    function Field({ field, value, t, onChange }) {
      if (field.kind === 'boolean') {
        return h(
          'label',
          { style: styles.check },
          h('input', {
            type: 'checkbox',
            checked: value === true,
            onChange: (event) => onChange(field.key, event.target.checked),
          }),
          h('span', null, t(field.label)),
        );
      }
      const type =
        field.kind === 'secret' ? 'password' : field.kind === 'number' ? 'number' : 'text';
      return h(
        'label',
        { style: styles.label },
        h('span', { style: styles.labelText }, t(field.label)),
        h('input', {
          type,
          value: value === undefined || value === null ? '' : String(value),
          placeholder: field.placeholder ?? '',
          autoComplete: field.kind === 'secret' ? 'new-password' : 'off',
          style: styles.input,
          onChange: (event) =>
            onChange(
              field.key,
              field.kind === 'number'
                ? event.target.value === ''
                  ? DEFAULTS[field.key]
                  : Number(event.target.value)
                : event.target.value,
            ),
        }),
        field.hint ? h('span', { style: styles.hint }, t(field.hint)) : null,
      );
    }

    function FormPage({ form, t }) {
      const [values, setValues] = useState(() => readValues(form));
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState(null);
      const state = form && form.state ? form.state : undefined;
      const revision = state === undefined ? undefined : state.revision;

      useEffect(() => {
        setValues(readValues(form));
      }, [revision]);

      const update = useCallback((key, value) => {
        setValues((previous) => ({ ...previous, [key]: value }));
      }, []);

      const save = useCallback(async () => {
        if (!form || typeof form.mutate !== 'function' || state === undefined) return;
        const base = readValues(form);
        const operations = [];
        for (const field of FIELDS) {
          if (!same(values[field.key], base[field.key])) {
            operations.push({ op: 'set', path: [field.key], value: values[field.key] });
          }
        }
        if (operations.length === 0) {
          setNotice('unchanged');
          return;
        }
        setBusy(true);
        setNotice(null);
        try {
          const accepted = await form.mutate(operations, state.revision);
          setNotice(accepted === false ? 'failed' : 'saved');
        } catch {
          setNotice('failed');
        } finally {
          setBusy(false);
        }
      }, [form, state, values]);

      if (!form) {
        return h('p', { style: styles.hint }, t('unavailable'));
      }

      const loading = state === undefined || state.status === 'loading';
      const writable = state === undefined || state.writable !== false;

      return h(
        'section',
        { style: styles.section },
        h('h3', { style: styles.heading }, t('title')),
        h('p', { style: styles.intro }, t('intro')),
        ...FIELDS.map((field) =>
          h(Field, { key: field.key, field, value: values[field.key], t, onChange: update }),
        ),
        h(
          'div',
          { style: styles.actions },
          h(
            'button',
            { type: 'button', style: styles.button, disabled: busy || loading || !writable, onClick: save },
            busy ? t('saving') : t('save'),
          ),
          notice === null ? null : h('span', { style: styles.notice, role: 'status' }, t(notice)),
        ),
        loading ? h('p', { style: styles.hint }, t('loading')) : null,
        !writable ? h('p', { style: styles.hint }, t('readonly')) : null,
      );
    }

    /**
     * Fallback for a page that hands no Host form (an older page build or a
     * namespace mismatch): locate the Host settings namespace ourselves through
     * the shared configuration mirror and drive its form controller directly.
     */
    function ControllerPage({ configForms, t }) {
      const [controller, setController] = useState(null);
      const [snapshot, setSnapshot] = useState(null);

      useEffect(() => {
        if (!configForms || typeof configForms.get !== 'function') return undefined;
        const mirror = typeof configForms.describe === 'function' ? configForms.describe() : undefined;
        const locate = () => {
          let namespaces = [];
          try {
            const view = mirror && typeof mirror.getSnapshot === 'function'
              ? mirror.getSnapshot().view
              : undefined;
            namespaces = view && Array.isArray(view.namespaces) ? view.namespaces : [];
          } catch {
            namespaces = [];
          }
          const match = namespaces.find((row) => {
            const id = String(row && row.ns);
            return id === 'qwen-asr' || id === 'include:qwen-asr' || id.endsWith(':qwen-asr');
          });
          if (match === undefined) return;
          setController((previous) => previous ?? configForms.get(match.ns));
        };
        locate();
        if (mirror && typeof mirror.ensure === 'function') mirror.ensure();
        return mirror && typeof mirror.subscribe === 'function' ? mirror.subscribe(locate) : undefined;
      }, [configForms]);

      useEffect(() => {
        if (controller === null) return undefined;
        const update = () => setSnapshot(controller.getSnapshot());
        update();
        return controller.subscribe(update);
      }, [controller]);

      if (!configForms) {
        return h('p', { style: styles.hint }, t('unavailable'));
      }
      const form =
        controller === null || snapshot === null
          ? undefined
          : {
              state: snapshot,
              mutate: (operations, revision) => controller.mutate(operations, revision),
            };
      return h(FormPage, { form, t });
    }

    function ConfigForm(props) {
      if (props.view === 'summary') {
        return h('span', { style: styles.hint }, props.t('summary'));
      }
      if (props.form) return h(FormPage, { form: props.form, t: props.t });
      return h(ControllerPage, { configForms: props.configForms, t: props.t });
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'qwen-asr: dictionaries');
        const t = ctx.locale.bind(NS);
        const configForms = () => {
          try {
            return ctx.get('configForms');
          } catch {
            return undefined;
          }
        };
        ctx.effect(
          () =>
            ctx.slots.inject('plugins.row.config', () =>
              ctx.slots.register(
                { name: 'plugins.row.config', key: ROW_CONFIG_KEY, locale: NS },
                (props) =>
                  h(ConfigForm, {
                    view: props.view,
                    form: props.form,
                    configForms: configForms(),
                    t,
                  }),
              ),
            ),
          'qwen-asr: row configuration page',
        );
      },
    };
  },
});
