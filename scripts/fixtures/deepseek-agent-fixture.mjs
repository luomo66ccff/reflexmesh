import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FIXTURE_TOOL = 'reflexmesh_fixture_read';
export const FIXTURE_MARKER = 'REFLEXMESH_SYNTHETIC_AGENT_OK';
const PROVIDER = 'reflexmesh-synthetic';
const MODEL = 'fixture-v1';
const ARGS = { key: 'synthetic-only' };

const plugin = {
  name: 'reflexmesh-synthetic-fixture',
  inject: ['llm', 'tools', 'reflexmeshObserverReady'],
  async apply(ctx, config) {
    if (!config || typeof config.packageRoot !== 'string' || typeof config.telemetryPath !== 'string'
      || typeof config.homePath !== 'string' || typeof config.cwdPath !== 'string'
      || typeof config.overlayPath !== 'string') {
      throw new TypeError('Synthetic fixture paths required');
    }
    const profileName = config.profileName ?? 'reflexmesh-probe';
    if (profileName !== 'reflexmesh-probe' && profileName !== 'web')
      throw new TypeError('Unsupported synthetic fixture profile');
    const profileManifest = JSON.parse(readFileSync(join(config.homePath, 'profiles', profileName, 'package.json'), 'utf8'));
    const bundles = profileManifest.dsh?.profile?.bundles;
    const bundleShape = profileName === 'web'
      ? Array.isArray(bundles) && bundles.includes('@deepseek-ai/dsh-base')
        && bundles.includes('@deepseek-ai/dsh-web-app')
      : Array.isArray(bundles) && bundles.length === 0;
    const isolatedProfileLoaded = process.env.DSH_HOME === config.homePath && process.cwd() === config.cwdPath
      && bundleShape && (profileName === 'web' || profileManifest.dsh.profile.patchReload === 'startup');
    const observerReady = ctx.get('reflexmeshObserverReady');
    const profileFile = join(config.homePath, 'profiles', profileName, 'cordis.yml');
    const loaderProfileBound = ctx.fiber?.entry?.parent?.tree?.filename === profileFile;
    const expectedObserverUrl = new URL('../../adapters/deepseek-loader-plugin.mjs', import.meta.url).href;
    const observerEntry = [...(ctx.get('loader')?.entries() ?? [])].find(entry => entry.options?.id === 'reflexmesh-observer');
    const observerEntryActivated = observerEntry?.options?.name === expectedObserverUrl
      && observerEntry.fiber?.state === 2 && observerEntry.parent?.tree?.filename === profileFile;
    const profilePatch = readFileSync(join(config.homePath, 'profiles', profileName, 'cordis.patch.yml'), 'utf8');
    const overlayPatch = readFileSync(config.overlayPath, 'utf8');
    const patchArg = process.argv.indexOf('--patch');
    const observerOverlayViaCli = observerEntryActivated && patchArg >= 0
      && process.argv[patchArg + 1] === config.overlayPath
      && !profilePatch.includes('reflexmesh-observer')
      && overlayPatch.includes('"id":"reflexmesh-observer"')
      && overlayPatch.includes(expectedObserverUrl);
    const sibling = name => join(dirname(config.packageRoot), name);
    // Exact installed modules are supplied by the isolated probe, never ambient resolution.
    const llmManifest = JSON.parse(readFileSync(join(sibling('dsh-llm'), 'package.json'), 'utf8'));
    const toolsManifest = JSON.parse(readFileSync(join(sibling('dsh-tools'), 'package.json'), 'utf8'));
    if (llmManifest.name !== '@deepseek-ai/dsh-llm' || toolsManifest.name !== '@deepseek-ai/dsh-tools'
      || llmManifest.version !== '0.1.2-rc.1' || toolsManifest.version !== '0.1.2-rc.1') {
      throw new Error('Unsupported synthetic fixture host modules');
    }
    const [{ LlmAdapter }, { defineTool }] = await Promise.all([
      import(pathToFileURL(join(sibling('dsh-llm'), 'lib', 'index.js')).href),
      import(pathToFileURL(join(sibling('dsh-tools'), 'lib', 'index.js')).href),
    ]);
    const state = { isolatedProfileLoaded, loaderProfileBound, observerEntryActivated,
      observerOverlayViaCli,
      naturalBeforeExit: false, observerDrainedAtExit: false, kernelClosedAtExit: false,
      requests: 0, backgroundRequests: 0, totalRequests: 0,
      bodyCalls: 0, toolAdvertised: false, toolCount: 0,
      toolHadAgent: false, toolArgsExact: false, toolResultSeen: false, sessionConsistent: false,
      modelSessionId: null, toolSessionId: null, toolAgentId: null };
    const save = () => writeFileSync(config.telemetryPath, JSON.stringify(state), 'utf8');
    save();
    process.once('beforeExit', () => { state.naturalBeforeExit = true; try { save(); } catch {} });
    process.once('exit', () => {
      state.observerDrainedAtExit = observerReady?.observerDrained === true;
      state.kernelClosedAtExit = observerReady?.kernelClosed === true;
      try { save(); } catch {}
    });
    class SyntheticAdapter extends LlmAdapter {
      listModels(provider) {
        return Promise.resolve(provider === PROVIDER
          ? [{ id: MODEL, name: 'ReflexMesh synthetic fixture' }] : []);
      }
      async *stream(options) {
        state.totalRequests += 1;
        options.signal?.throwIfAborted();
        if (options.provider !== PROVIDER || options.model !== MODEL || state.totalRequests > 4) {
          throw new Error('Unexpected synthetic adapter request');
        }
        const fixtureTask = options.messages?.some(message =>
          message.source?.kind === 'user' && message.content?.some(block => block.type === 'text'
            && block.text.startsWith('ReflexMesh-Intent: '))) === true;
        if (!fixtureTask && profileName === 'web') {
          state.backgroundRequests += 1;
          save();
          yield { type: 'text-delta', index: 0, text: 'Synthetic fixture title' };
          yield { type: 'finish', reason: { kind: 'stop' } };
          return;
        }
        state.requests += 1;
        if (state.requests === 1) {
          state.modelSessionId = options.sessionId ?? null;
          state.toolCount = Array.isArray(options.tools) ? options.tools.length : -1;
          state.toolAdvertised = options.tools?.some(tool => tool.name === FIXTURE_TOOL) === true;
          save();
          if (!state.toolAdvertised) throw new Error('Fixture tool was not advertised');
          yield { type: 'tool-call-delta', index: 0, id: 'fixture-call-1',
            name: FIXTURE_TOOL, argumentsDelta: JSON.stringify(ARGS) };
          yield { type: 'finish', reason: { kind: 'stop' } };
          return;
        }
        state.toolResultSeen = options.messages?.some(message => message.content?.some(block =>
          block.type === 'tool-result' && block.toolCallId === 'fixture-call-1'
          && block.isError === false && block.content?.some(part => part.type === 'text' && part.text === 'synthetic-read-ok'))) === true;
        state.sessionConsistent = typeof options.sessionId === 'string' && options.sessionId === state.modelSessionId
          && options.messages?.some(message =>
          message.source?.kind === 'user' && message.content?.some(block => block.type === 'text'
            && block.text.startsWith('ReflexMesh-Intent: '))) === true;
        save();
        if (!state.toolResultSeen || !state.sessionConsistent) throw new Error('Native tool result was not returned to adapter');
        yield { type: 'text-delta', index: 0, text: FIXTURE_MARKER };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    ctx.llm.registerAdapter([PROVIDER], new SyntheticAdapter());
    ctx.tools.register(defineTool({
      name: FIXTURE_TOOL, description: 'Read a fixed in-memory synthetic value',
      parameters: { key: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        state.bodyCalls += 1;
        state.toolArgsExact = Object.keys(args).length === 1 && args.key === ARGS.key;
        state.toolHadAgent = Boolean(exec?.agent && exec.agent.id === exec.agent.session?.id);
        state.toolSessionId = exec?.agent?.session?.id ?? null;
        state.toolAgentId = exec?.agent?.id ?? null;
        save();
        if (!state.toolArgsExact || !state.toolHadAgent) throw new Error('Fixture tool scope mismatch');
        return 'synthetic-read-ok';
      },
    }));
    ctx.provide('reflexmeshSyntheticFixtureReady', true);
  },
};

export default plugin;
