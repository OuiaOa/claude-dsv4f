#!/usr/bin/env node
/**
 * End-to-end test for the dsv4shim shim against a mock DeepSeek Anthropic endpoint.
 * Verifies the effort translation (especially xhigh->max, which is what makes ultracode
 * work), slot routing, model allowlist, cache hygiene, streaming usage capture and the cap.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsv4shim-test-'));
const CONFIG_DIR = path.join(TMP, 'config');
const DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(CONFIG_DIR); fs.mkdirSync(DATA_DIR);

const MOCK_PORT = 9911;
const SHIM_PORT = 8799;
const SENTINEL = 'test-sentinel-abc';

fs.writeFileSync(path.join(CONFIG_DIR, 'key'), 'sk-test-key');
fs.writeFileSync(path.join(CONFIG_DIR, 'sentinel'), SENTINEL);
fs.writeFileSync(path.join(CONFIG_DIR, 'deepinfra-key'), 'di-test-key');

const VISION_PORT = 9912;

// The repo's own shipped default, not the machine's live ~/.config/dsv4shim/config.json —
// the suite must pass on a fresh checkout (a new contributor, CI, a worktree with no install
// on the box at all), not only on a machine that already has this tool set up.
const realCfg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'config.default.json'), 'utf8'));
// Resolve the shim next to this test, so a worktree tests its own code and not the install.
const cfg = {
  ...realCfg,
  port: SHIM_PORT,
  upstream: `http://127.0.0.1:${MOCK_PORT}/anthropic`,
  balance: { settleSeconds: 99999, idlePollSeconds: 99999, lowBalanceWarnUsd: 5 },
  cap: { dailyUsd: 5.0 },
  vision: { ...realCfg.vision, endpoint: `http://127.0.0.1:${VISION_PORT}/v1/openai/chat/completions` },
};
fs.writeFileSync(path.join(CONFIG_DIR, 'config.json'), JSON.stringify(cfg, null, 2));
fs.writeFileSync(path.join(CONFIG_DIR, 'probe-results.json'), JSON.stringify({
  effortField: 'output_config', effortSupported: true, usageHasCacheFields: true,
  countTokensSupported: false, thinkingDisabledHonored: true,
}));

// ------------------------------------------------------------------ mock upstream
const seen = [];
let classifierRetryAttempts = 0;
let exhaustAttempts = 0;
let trafficActive = 0;
let maxTrafficActive = 0;
let backgroundTrafficActive = 0;
let maxBackgroundTrafficActive = 0;
const mock = http.createServer((req, res) => {
  // Accumulate as Buffers and decode ONCE. `b += d` on a Buffer calls toString() per
  // chunk, which corrupts any UTF-8 character straddling a chunk boundary — the exact
  // defect the multi-byte-integrity test below exists to catch. Decoding per chunk here
  // made this harness able to manufacture that corruption itself and blame the shim.
  const chunks = [];
  req.on('data', d => { chunks.push(d); });
  req.on('end', () => {
    const b = Buffer.concat(chunks).toString('utf8');
    const body = JSON.parse(b || '{}');
    seen.push({ path: req.url, body, auth: req.headers.authorization });

    // A delayed marker lets the end-to-end suite verify the local pay-as-you-go traffic gate,
    // including its stricter background lane, without relying on a real provider rate limit.
    const marker = JSON.stringify(body.system ?? '');
    if (/TRAFFIC_MAIN_MARKER|TRAFFIC_BACKGROUND_MARKER/.test(marker)) {
      const background = /TRAFFIC_BACKGROUND_MARKER/.test(marker);
      trafficActive++;
      maxTrafficActive = Math.max(maxTrafficActive, trafficActive);
      if (background) { backgroundTrafficActive++; maxBackgroundTrafficActive = Math.max(maxBackgroundTrafficActive, backgroundTrafficActive); }
      return setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'traffic', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 20, output_tokens: 2 } }));
        trafficActive--;
        if (background) backgroundTrafficActive--;
      }, 80);
    }

    // Test hook: a classifier-shaped request carrying this marker fails the connection
    // (no response at all — simulating a stall/reset) on its first two attempts, then
    // succeeds on the third. Exercises the shim's classifier-only retry-with-backoff.
    if (/RETRY_TEST_MARKER/.test(JSON.stringify(body.system ?? ''))) {
      classifierRetryAttempts++;
      if (classifierRetryAttempts <= 2) { req.socket.destroy(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_retry_ok', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 50, output_tokens: 5 },
      }));
      return;
    }

    // Test hook: a classifier-shaped request carrying this marker ALWAYS fails the
    // connection — every attempt, no eventual success. Exercises full retry exhaustion
    // (confirmed live 2026-08-13: sustained DeepSeek peak-window degradation can outlast
    // more than 2-3 quick attempts) — the shim must make its full configured attempt count,
    // then give up cleanly with an error, never hang past that.
    if (/EXHAUST_TEST_MARKER/.test(JSON.stringify(body.system ?? ''))) {
      exhaustAttempts++;
      req.socket.destroy();
      return;
    }

    // Test hook: a hard upstream failure. The shim must relay it AND record a ledger row —
    // without the row, the ledger holds successes only and every 429/503 is invisible.
    if (/UPSTREAM_FAIL_MARKER/.test(JSON.stringify(body.system ?? ''))) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'upstream overloaded' } }));
      return;
    }

    // Test hook: 200 status but a body that isn't JSON — still billed by upstream, must
    // not be silently treated as free.
    if (/NON_JSON_200_MARKER/.test(JSON.stringify(body.system ?? ''))) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('not json, but still a real 200 the provider will bill for');
      return;
    }

    // Test hook: a streaming response that sends message_start (with real usage) and then
    // the connection dies mid-flight, before message_stop — no clean end() ever happens.
    if (/MID_STREAM_CUTOFF_MARKER/.test(JSON.stringify(body.system ?? ''))) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: ' + JSON.stringify({
        type: 'message_start',
        message: { id: 'msg_cutoff', usage: { input_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } },
      }) + '\n\n');
      res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', delta: { text: 'partial' } }) + '\n\n');
      setImmediate(() => req.socket.destroy());
      return;
    }

    // Test hook: when the user prompt is "mark for bash test", return a Bash tool_use
    // block with is_background: true. The shim's response sanitizer must override it to
    // false because the command "ls -la" has no background syntax.
    const lastUserText = (() => {
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === 'user') {
        const c = msgs[i].content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.map(b => b?.text || '').join(' ');
      }
      return '';
    })();
    const wantsBashTest = lastUserText.trim() === 'mark for bash test';
    // Regression hook: the command STRING VALUE itself contains the literal text
    // `"is_background":true` (as if the agent were writing a JSON file). The old streaming
    // sanitizer did a raw text-level regex replace over the whole accumulated tool_use JSON,
    // which would have mangled this occurrence too, even though it's inside a string value,
    // not the actual is_background key.
    const wantsBashCorruptionTest = lastUserText.trim() === 'mark for bash corruption test';

    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: ' + JSON.stringify({
        type: 'message_start',
        message: { id: 'msg_1', usage: { input_tokens: 1000, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0, output_tokens: 1 } },
      }) + '\n\n');
      if (wantsBashTest) {
        res.write('event: content_block_start\ndata: ' + JSON.stringify({
          type: 'content_block_start', index: 0,
          content_block: { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: {} },
        }) + '\n\n');
        res.write('event: content_block_delta\ndata: ' + JSON.stringify({
          type: 'content_block_delta', index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"command":"ls -la","is_background":true}' },
        }) + '\n\n');
        res.write('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: 0 }) + '\n\n');
        res.write('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 10 } }) + '\n\n');
      } else if (wantsBashCorruptionTest) {
        const cmd = 'echo \'{"is_background":true}\' > /tmp/config.json';
        const inputJson = JSON.stringify({ command: cmd, is_background: true });
        res.write('event: content_block_start\ndata: ' + JSON.stringify({
          type: 'content_block_start', index: 0,
          content_block: { type: 'tool_use', id: 'toolu_bash2', name: 'Bash', input: {} },
        }) + '\n\n');
        res.write('event: content_block_delta\ndata: ' + JSON.stringify({
          type: 'content_block_delta', index: 0,
          delta: { type: 'input_json_delta', partial_json: inputJson },
        }) + '\n\n');
        res.write('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: 0 }) + '\n\n');
        res.write('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 10 } }) + '\n\n');
      } else {
        res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', delta: { text: 'ok' } }) + '\n\n');
        res.write('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 250 } }) + '\n\n');
      }
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (wantsBashTest) {
        res.end(JSON.stringify({
          id: 'msg_bash', type: 'message', role: 'assistant',
          content: [{
            type: 'tool_use', id: 'toolu_bash', name: 'Bash',
            input: { command: 'ls -la', is_background: true },
          }],
          stop_reason: 'tool_use', stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 10 },
        }));
      } else {
        res.end(JSON.stringify({
          id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1000, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0, output_tokens: 250 },
        }));
      }
    }
  });
});
await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r));

// ------------------------------------------------------------ mock vision model
let visionCalls = 0;
const visionMock = http.createServer((req, res) => {
  // Accumulate as Buffers and decode ONCE. `b += d` on a Buffer calls toString() per
  // chunk, which corrupts any UTF-8 character straddling a chunk boundary — the exact
  // defect the multi-byte-integrity test below exists to catch. Decoding per chunk here
  // made this harness able to manufacture that corruption itself and blame the shim.
  const chunks = [];
  req.on('data', d => { chunks.push(d); });
  req.on('end', () => {
    const b = Buffer.concat(chunks).toString('utf8');
    visionCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: 'A red Submit button clipped at the right edge of a 280px card.' } }],
      usage: { prompt_tokens: 1200, completion_tokens: 240 },
    }));
  });
});
await new Promise(r => visionMock.listen(VISION_PORT, '127.0.0.1', r));

// ---------------------------------------------------------------------- shim
const shim = spawn(process.execPath, [path.join(import.meta.dirname, 'shim.mjs')], {
  env: { ...process.env, DSV4SHIM_CONFIG_DIR: CONFIG_DIR, DSV4SHIM_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let shimLog = '';
shim.stdout.on('data', d => { shimLog += d; });
shim.stderr.on('data', d => { shimLog += d; });

// Never leave an orphaned shim holding the test port if an assertion throws.
const cleanup = () => { try { shim.kill("SIGKILL"); } catch {} try { mock.close(); } catch {} try { visionMock.close(); } catch {} };
process.on('exit', cleanup);
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); cleanup(); process.exit(1); });

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${SHIM_PORT}/_dsv4shim/health`);
      if (r.ok) return true;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}
if (!await waitUp()) { console.error('shim failed to start:\n' + shimLog); process.exit(1); }

// --------------------------------------------------------------------- helpers
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  -> ${detail}` : ''}`); fail++; }
}

async function send(body, { sentinel = SENTINEL } = {}) {
  const r = await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sentinel}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, text, last: seen[seen.length - 1] };
}

const msg = (extra = {}, text = 'hi') => ({
  model: 'deepseek-v4-pro-medium', max_tokens: 100,
  messages: [{ role: 'user', content: text }], ...extra,
});

console.log('\n\x1b[1mdsv4shim shim tests\x1b[0m\n');
console.log('\x1b[1meffort translation\x1b[0m');

let r = await send(msg());
check('default profile is pro at medium', r.last?.body?.output_config?.effort === 'medium', JSON.stringify(r.last?.body?.output_config));

r = await send(msg({ output_config: { effort: 'xhigh' } }));
check('ULTRACODE: xhigh -> max', r.last?.body?.output_config?.effort === 'max', JSON.stringify(r.last?.body?.output_config));

// medium is a real level upstream (measured enum: low|medium|high|xhigh|ultra|max),
// so it passes through rather than being rounded up to high.
r = await send(msg({ output_config: { effort: 'medium' } }));
check('medium -> medium (real upstream level)', r.last?.body?.output_config?.effort === 'medium', JSON.stringify(r.last?.body?.output_config));

r = await send(msg({ output_config: { effort: 'low' } }));
check('low -> low', r.last?.body?.output_config?.effort === 'low');

// Background now thinks a little rather than not at all — 'low' by explicit request. `none` is
// still not a real upstream level (it 400s); it is encoded as thinking:{type:"disabled"}, which
// is what this path used to send.
r = await send({ ...msg(), model: 'deepseek-v4-flash-low' });
check('background profile runs on flash', r.last?.body?.model === 'deepseek-v4-flash',
  String(r.last?.body?.model));
check('background profile thinks at low, not disabled',
  r.last?.body?.output_config?.effort === 'low' && r.last?.body?.thinking === undefined,
  JSON.stringify({ effort: r.last?.body?.output_config, thinking: r.last?.body?.thinking }));

r = await send({ ...msg(), model: 'deepseek-v4-flash-sub' });
check('subagent slot -> high', r.last?.body?.output_config?.effort === 'high',
  JSON.stringify(r.last?.body?.output_config));

// Ultracode promotion of subagents must be scoped to the session that asked for it.
await send(msg({ output_config: { effort: 'xhigh' }, metadata: { user_id: 'sess-A' } }));
r = await send({ ...msg({ metadata: { user_id: 'sess-A' } }), model: 'deepseek-v4-flash-sub' });
check('ultracode keeps helper subagents on their configured effort (no pay-as-you-go promotion)', r.last?.body?.output_config?.effort === 'high');
r = await send({ ...msg({ metadata: { user_id: 'sess-B' } }), model: 'deepseek-v4-flash-sub' });
check('other sessions unaffected -> high', r.last?.body?.output_config?.effort === 'high',
  JSON.stringify(r.last?.body?.output_config));
r = await send({ ...msg(), model: 'deepseek-v4-flash-sub' });
check('unidentified session never promoted -> high', r.last?.body?.output_config?.effort === 'high',
  JSON.stringify(r.last?.body?.output_config));

r = await send(msg({}, 'please ultrathink about this one'));
check('ultrathink keyword -> max', r.last?.body?.output_config?.effort === 'max');

// An automatic guess escalates to ultra, not max: measured, max costs ~39% more wall-clock
// for ~35% more reasoning, which is only worth it when explicitly asked for.
const hardPrompt = 'Investigate the root cause of this intermittent race condition. '.repeat(20);
r = await send(msg({}, hardPrompt));
check('heuristic escalates hard task -> ultra', r.last?.body?.output_config?.effort === 'ultra',
  JSON.stringify(r.last?.body?.output_config));

// A deliberately chosen level must never be escalated by a guess — otherwise picking `low`
// to save money would spend more on exactly the prompts that look hard.
r = await send(msg({ output_config: { effort: 'low' } }, hardPrompt));
check('explicit low is NOT escalated on a hard prompt', r.last?.body?.output_config?.effort === 'low',
  JSON.stringify(r.last?.body?.output_config));
r = await send(msg({ output_config: { effort: 'medium' } }, hardPrompt));
check('explicit medium is NOT escalated', r.last?.body?.output_config?.effort === 'medium',
  JSON.stringify(r.last?.body?.output_config));
// ...but ultrathink is explicit intent and overrides a pinned level.
r = await send(msg({ output_config: { effort: 'low' } }, 'ultrathink about this'));
check('ultrathink overrides a pinned low -> max', r.last?.body?.output_config?.effort === 'max',
  JSON.stringify(r.last?.body?.output_config));

r = await send(msg({}, 'ok thanks'));
check('short simple turn stays at the profile default', r.last?.body?.output_config?.effort === 'medium');

console.log('\n\x1b[1mmodel allowlist\x1b[0m');
// V4 Pro is now a ROUTED model, not a denied one: it backs the main slot and the
// opus/fable tiers (upstreamModels in config.default.json). Asking for it by name lands on
// the main slot via `sentinels` rather than being refused.
r = await send({ ...msg(), model: 'deepseek-v4-pro-high' });
check('a pro profile is served', r.status === 200, `status=${r.status}`);
check('a pro profile reaches upstream as the REAL model', r.last?.body?.model === 'deepseek-v4-pro',
  String(r.last?.body?.model));

// The deny list still exists — it just no longer covers V4 Pro. Models the profile was never
// meant to bill remain refused, so removing one entry did not disarm the guard.
const beforeDeny = seen.length;
r = await send({ ...msg(), model: 'deepseek-chat' });
check('deepseek-chat still refused with 403', r.status === 403, `status=${r.status}`);
check('denied request never reached upstream', seen.length === beforeDeny);
check('refusal explains why', /refuses model/.test(r.text));

r = await send({ ...msg(), model: 'claude-opus-4-5' });
check('claude-* remapped to deepseek-v4-flash', r.last?.body?.model === 'deepseek-v4-flash');

console.log('\n\x1b[1mrequest hygiene\x1b[0m');
r = await send(msg({
  metadata: { user_id: 'user-123' },
  system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
  thinking: { type: 'adaptive' },
}));
check('metadata.user_id stripped (protects KV cache)', r.last?.body?.metadata?.user_id === undefined);
check('cache_control stripped', r.last?.body?.system?.[0]?.cache_control === undefined);
check('thinking:adaptive suppressed', r.last?.body?.thinking === undefined || r.last?.body?.thinking?.type !== 'adaptive');
check('real key injected upstream', r.last?.auth === 'Bearer sk-test-key');

r = await send(msg({ max_tokens: 999999 }));
check('max_tokens clamped to 384k', r.last?.body?.max_tokens === 384000, String(r.last?.body?.max_tokens));

console.log('\n\x1b[1mauth\x1b[0m');
r = await send(msg(), { sentinel: 'wrong-token' });
check('bad sentinel rejected with 401', r.status === 401);

console.log('\n\x1b[1mstreaming + ledger\x1b[0m');
const sres = await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
  method: 'POST',
  headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
  body: JSON.stringify(msg({ stream: true })),
});
const stext = await sres.text();
check('stream passed through intact', stext.includes('message_start') && stext.includes('message_stop'));
await new Promise(r => setTimeout(r, 300));

const ledger = fs.readFileSync(path.join(DATA_DIR, 'usage.jsonl'), 'utf8')
  .split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
const streamRow = ledger.filter(r => r.streaming).pop();
check('ledger recorded streaming request', !!streamRow);
check('captured input tokens from message_start', streamRow?.inputTokens === 1000, String(streamRow?.inputTokens));
check('captured output tokens from message_delta', streamRow?.outputTokens === 250, String(streamRow?.outputTokens));
check('captured cache read tokens', streamRow?.cacheReadTokens === 4000, String(streamRow?.cacheReadTokens));
check('cost is exact when cache split present', streamRow?.exact === true);

// Priced against the model that actually served the turn, not a single global rate. This
// request carries the bare main-slot sentinel, so upstreamModels.slots.main routes it to
// deepseek-v4-pro and it is billed at Pro's rates.
check('ledger records the real upstream model, not the routing sentinel',
  streamRow?.model === 'deepseek-v4-pro', String(streamRow?.model));

// 1000 miss + 0 create @0.66/M + 4000 hit @0.022/M + 250 out @1.98/M, times whatever peak
// multiplier was in force when the row was written. peakSurcharge is live now, so that is 1
// or 2 depending on the UTC hour the suite happens to run in — read it back off the row
// rather than hardcoding one, which would make the suite fail for seven hours a day.
const PRO_RATES = { cacheHitInput: 0.022, cacheMissInput: 0.66, output: 1.98 };
const expected = ((1000 / 1e6) * PRO_RATES.cacheMissInput
  + (4000 / 1e6) * PRO_RATES.cacheHitInput
  + (250 / 1e6) * PRO_RATES.output) * (streamRow?.peakMultiplier ?? 1);
check('cost priced correctly', Math.abs(streamRow.costUsd - expected) < 1e-9,
  `got ${streamRow?.costUsd} want ${expected} (peak x${streamRow?.peakMultiplier})`);

// Regression: a 200 response upstream is always billed, even when its body isn't JSON
// (previously swallowed by `catch { /* ignore */ }` with no record() call at all — an
// undercounted-spend gap in the daily cap). The shim must record a best-effort estimate
// instead of treating it as free.
const nonJsonReq = {
  model: 'deepseek-v4-pro-medium', max_tokens: 100,
  system: 'NON_JSON_200_MARKER', messages: [{ role: 'user', content: 'hi' }],
};
const nonJsonResp = await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
  method: 'POST', headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
  body: JSON.stringify(nonJsonReq),
});
await new Promise(r => setTimeout(r, 100));
const ledgerAfterNonJson = fs.readFileSync(path.join(DATA_DIR, 'usage.jsonl'), 'utf8')
  .split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
const nonJsonRow = ledgerAfterNonJson[ledgerAfterNonJson.length - 1];
check('non-JSON 200 still reaches the client', nonJsonResp.status === 200);
check('non-JSON 200 is recorded (not silently free)', nonJsonRow?.estimated === true && nonJsonRow.costUsdMax > 0,
  JSON.stringify(nonJsonRow));

// Regression: a stream that dies mid-flight (after headers/message_start, before
// message_stop) used to end the client connection with no error event and no record() call
// — invisible both to the client's stream parser and to the spend ledger. The shim must
// emit a terminal SSE error event and record whatever usage was sniffed before the cut.
const cutoffReq = {
  model: 'deepseek-v4-pro-medium', max_tokens: 100, stream: true,
  system: 'MID_STREAM_CUTOFF_MARKER', messages: [{ role: 'user', content: 'hi' }],
};
const cutoffResp = await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
  method: 'POST', headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
  body: JSON.stringify(cutoffReq),
});
const cutoffText = await cutoffResp.text();
await new Promise(r => setTimeout(r, 100));
const ledgerAfterCutoff = fs.readFileSync(path.join(DATA_DIR, 'usage.jsonl'), 'utf8')
  .split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
const cutoffRow = ledgerAfterCutoff[ledgerAfterCutoff.length - 1];
check('mid-stream cutoff: client receives a terminal SSE error event, not a silent hang',
  cutoffText.includes('event: error'), cutoffText.slice(0, 200));
check('mid-stream cutoff: usage sniffed before the cut is still recorded',
  cutoffRow?.inputTokens === 300, JSON.stringify(cutoffRow));

console.log('\n\x1b[1mspend cap\x1b[0m');
fs.writeFileSync(path.join(CONFIG_DIR, 'cap'), '0.00000001');
r = await send(msg());
check('cap refuses with 403 (not 429, which would retry-spin)', r.status === 403, `status=${r.status}`);
check('cap message tells you how to raise it', /dsv4shim-cap/.test(r.text));
fs.writeFileSync(path.join(CONFIG_DIR, 'cap'), '5');
r = await send(msg());
check('raising the cap restores service', r.status === 200);

console.log('\n\x1b[1mmulti-byte integrity\x1b[0m');
// Chunked bodies must be decoded once, not per chunk: a UTF-8 character split across a chunk
// boundary would otherwise be corrupted. Source files with emoji or smart quotes hit this.
const unicode = 'café — “smart quotes” 日本語 🚀 ' + 'π'.repeat(40000);
r = await send(msg({}, unicode));
const roundTripped = r.last?.body?.messages?.[0]?.content;
check('multi-byte text survives a chunked body intact', roundTripped === unicode,
  `len sent=${unicode.length} got=${String(roundTripped).length}`);
check('no replacement characters introduced', !String(roundTripped).includes('�'));

console.log('\n\x1b[1munguarded paths\x1b[0m');
// Only /v1/messages is metered. Any other inference path forwarded verbatim would bill the
// real key while being invisible to the cap, the ledger and dsv4shim-usage.
for (const p of ['/v1/messages/', '/v1/messages/batches', '/v1/complete']) {
  const rr = await fetch(`http://127.0.0.1:${SHIM_PORT}${p}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
    body: '{}',
  });
  check(`unmetered path ${p} refused`, rr.status === 404, `status=${rr.status}`);
}

console.log('\n\x1b[1mvision routing\x1b[0m');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const imgMsg = (data = PNG) => ({
  model: 'deepseek-v4-pro-medium', max_tokens: 100,
  messages: [{ role: 'user', content: [
    { type: 'text', text: 'why is this button broken?' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
  ] }],
});

const callsBefore = visionCalls;
r = await send(imgMsg());
const sent = JSON.stringify(r.last?.body);
check('image block removed before reaching DeepSeek', !sent.includes('"type":"image"'), sent.slice(0, 120));
check('description substituted as text', /Submit button clipped/.test(sent));
check('substitution is labelled as a transcription', /transcribed by/.test(sent));
check('vision model was called once', visionCalls === callsBefore + 1, `calls=${visionCalls - callsBefore}`);

const callsAfterFirst = visionCalls;
r = await send(imgMsg());
check('identical image served from cache (no second vision call)', visionCalls === callsAfterFirst,
  `extra calls=${visionCalls - callsAfterFirst}`);
check('cached description is byte-identical (protects prefix cache)',
  JSON.stringify(r.last?.body).includes('Submit button clipped'));

const callsBeforeNew = visionCalls;
r = await send(imgMsg('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='));
check('a different image does trigger a new vision call', visionCalls === callsBeforeNew + 1);

// The common case in practice: the Read tool returns the image nested inside a tool_result,
// not at the top level of msg.content. Missing this depth lets images reach DeepSeek untouched.
const callsBeforeNested = visionCalls;
r = await send({
  model: 'deepseek-v4-pro-medium', max_tokens: 100,
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'look at this' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x.png' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA3fzQuwAAAABJRU5ErkJggg==' } },
    ] }] },
  ],
});
const nestedSent = JSON.stringify(r.last?.body);
check('image nested in tool_result is intercepted', visionCalls === callsBeforeNested + 1,
  `calls=${visionCalls - callsBeforeNested}`);
check('no image block survives inside tool_result', !nestedSent.includes('"type":"image"'),
  nestedSent.slice(0, 140));
check('nested description reaches DeepSeek', /Submit button clipped/.test(nestedSent));

const callsBeforeText = visionCalls;
r = await send(msg());
check('text-only request never touches the vision model', visionCalls === callsBeforeText);

// --- agent-directed focus ---------------------------------------------------------------
// The agent states what it needs before reading the image; that text steers the transcription.
let lastVisionBody = null;
visionMock.removeAllListeners('request');
visionMock.on('request', (req, res) => {
  // Accumulate as Buffers and decode ONCE. `b += d` on a Buffer calls toString() per
  // chunk, which corrupts any UTF-8 character straddling a chunk boundary — the exact
  // defect the multi-byte-integrity test below exists to catch. Decoding per chunk here
  // made this harness able to manufacture that corruption itself and blame the shim.
  const chunks = [];
  req.on('data', d => { chunks.push(d); });
  req.on('end', () => {
    const b = Buffer.concat(chunks).toString('utf8');
    visionCalls++;
    try { lastVisionBody = JSON.parse(b); } catch { lastVisionBody = null; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: 'A red Submit button clipped at the right edge of a 280px card.' } }],
      usage: { prompt_tokens: 1200, completion_tokens: 240 },
    }));
  });
});

const focusImg = (data, saidBefore) => ({
  model: 'deepseek-v4-pro-medium', max_tokens: 100,
  messages: [
    { role: 'assistant', content: [
      { type: 'text', text: saidBefore },
      { type: 'tool_use', id: 'tu9', name: 'Read', input: { file_path: '/shot.png' } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu9', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
    ] }] },
  ],
});

const F1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';
await send(focusImg(F1, 'VISION: exact pixel positions and z-order of every sprite on the canvas'));
const askText = JSON.stringify(lastVisionBody?.messages?.[1]?.content?.[0]?.text || '');
check('explicit VISION: marker reaches the vision model', /z-order of every sprite/.test(askText), askText.slice(0, 140));
check('focus supplements rather than replaces the full description',
  /describe the whole image completely/i.test(askText));

const F2 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAgH/JsUiUwAAAABJRU5ErkJggg==';
await send(focusImg(F2, 'Let me check whether the health bar overlaps the minimap.'));
const askText2 = JSON.stringify(lastVisionBody?.messages?.[1]?.content?.[0]?.text || '');
check('plain stated intent is used as focus when no marker', /health bar overlaps the minimap/.test(askText2),
  askText2.slice(0, 140));

// Focus is part of the cache key, but the SAME history must still replay from cache — otherwise
// the description would change between turns and break the upstream prompt-prefix cache.
const beforeReplay = visionCalls;
await send(focusImg(F1, 'VISION: exact pixel positions and z-order of every sprite on the canvas'));
check('same image + same focus replays from cache', visionCalls === beforeReplay,
  `extra calls=${visionCalls - beforeReplay}`);

const beforeDiff = visionCalls;
await send(focusImg(F1, 'VISION: read the score counter in the top right'));
check('different focus on same image is a distinct cache entry', visionCalls === beforeDiff + 1);

// Regression: two concurrent requests carrying the identical (never-before-seen) image both
// used to miss the cache and each pay for their own vision call — routine with parallel
// subagents re-sending the same screenshot before either's description is cached yet.
const F3 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPjPwAAEDAIA/isKoAAAAABJRU5ErkJggg==';
const beforeConcurrent = visionCalls;
await Promise.all([send(imgMsg(F3)), send(imgMsg(F3))]);
check('concurrent requests for the same never-seen image share one in-flight vision call',
  visionCalls === beforeConcurrent + 1, `extra calls=${visionCalls - beforeConcurrent}`);

r = await send(msg({ system: 'You are a coding agent.' }));
check('hint appended to a string system prompt',
  /VISION: <what to look for>/.test(String(r.last?.body?.system || '')), String(r.last?.body?.system).slice(0, 120));

r = await send(msg({ system: [{ type: 'text', text: 'You are a coding agent.' }] }));
check('hint appended to a block-array system prompt',
  /VISION: <what to look for>/.test(JSON.stringify(r.last?.body?.system || '')));

// Appending must be idempotent, or the prompt prefix would grow on every turn and never cache.
const twice = await send(msg({ system: String(r.last?.body?.system?.[0]?.text || '') }));
const hintCount = (String(twice.last?.body?.system || '').match(/VISION: <what to look for>/g) || []).length;
check('hint is not appended twice (prefix stays stable)', hintCount === 1, `count=${hintCount}`);

// Vision has its own cap against a separate provider and credit pool.
fs.writeFileSync(path.join(CONFIG_DIR, 'vision-cap'), '0.0000001');
const callsAtCap = visionCalls;
r = await send(imgMsg('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAgH/q842iQAAAABJRU5ErkJggg=='));
const capSent = JSON.stringify(r.last?.body);
check('vision cap blocks NEW descriptions', visionCalls === callsAtCap, `extra calls=${visionCalls - callsAtCap}`);
check('capped image degrades to a clear note, not an error', r.status === 200 && /vision spending cap reached/.test(capSent), capSent.slice(0, 160));
// Regression: the placeholder text must be the same fixed phrase every time the SAME failure
// class recurs — not the live "spent ~$X.XXXX" figure — or DeepSeek's prompt-prefix cache
// gets busted on every single turn for as long as the cap stays hit. Failures are never
// written to the persistent cache, so this second call re-hits the live cap check exactly
// like the first did.
const secondCapped = await send(imgMsg('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAgH/q842iQAAAABJRU5ErkJggg=='));
const extractPlaceholder = (body) => {
  const m = String(body).match(/description unavailable[^"]*/);
  return m?.[0];
};
check('capped placeholder text is byte-stable across repeats (preserves the prompt-prefix cache)',
  extractPlaceholder(capSent) === extractPlaceholder(JSON.stringify(secondCapped.last?.body)),
  `${extractPlaceholder(capSent)} vs ${extractPlaceholder(JSON.stringify(secondCapped.last?.body))}`);
check('coding request still succeeds when vision is capped', r.status === 200);
// A cached image costs nothing, so it must keep working past the cap.
r = await send(imgMsg());
check('cached images still served past the cap', JSON.stringify(r.last?.body).includes('Submit button clipped'));
fs.writeFileSync(path.join(CONFIG_DIR, 'vision-cap'), '1.5');

const vrow = fs.readFileSync(path.join(DATA_DIR, 'usage.jsonl'), 'utf8')
  .split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l)).filter(x => x.slot === 'vision');
check('vision calls logged separately in the ledger', vrow.length >= 1, `rows=${vrow.length}`);
check('vision cost attributed to deepinfra', vrow[0]?.provider === 'deepinfra');

// Providers share one ledger, so every row must declare its provider — otherwise DeepInfra
// dollars are charged against the DeepSeek cap AND the vision cap, i.e. billed twice.
const allRows = fs.readFileSync(path.join(DATA_DIR, 'usage.jsonl'), 'utf8')
  .split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
check('every ledger row declares a provider', allRows.every(r => r.provider === 'deepseek' || r.provider === 'deepinfra'),
  `missing on ${allRows.filter(r => !r.provider).length} rows`);

const liveSummary = await (await fetch(`http://127.0.0.1:${SHIM_PORT}/_dsv4shim/usage`, {
  headers: { authorization: `Bearer ${SENTINEL}` },
})).json();
const dsLedger = allRows.filter(r => (r.provider || 'deepseek') === 'deepseek')
  .reduce((s, r) => s + (r.costUsdMax ?? r.costUsd ?? 0), 0);
const diLedger = allRows.filter(r => r.provider === 'deepinfra')
  .reduce((s, r) => s + (r.costUsdMax ?? r.costUsd ?? 0), 0);
check("DeepSeek spend excludes vision cost", Math.abs(liveSummary.todayUsd - dsLedger) < 1e-6,   // summary rounds to 6dp
  `reported=${liveSummary.todayUsd} deepseek-only=${dsLedger}`);
check("vision spend tracked against its own provider", Math.abs(liveSummary.vision.spentUsd - diLedger) < 1e-6,
  `reported=${liveSummary.vision.spentUsd} deepinfra-only=${diLedger}`);
check('the two provider totals do not overlap', diLedger > 0 && liveSummary.todayUsd !== liveSummary.vision.spentUsd);

console.log('\n\x1b[1musage endpoint\x1b[0m');
// The usage summary embeds the DeepSeek account balance, so it must not be readable without
// the sentinel, and a rebound Host must not reach it either.
const unauth = await fetch(`http://127.0.0.1:${SHIM_PORT}/_dsv4shim/usage`);
check('usage endpoint requires the sentinel', unauth.status === 401, `status=${unauth.status}`);
const health = await fetch(`http://127.0.0.1:${SHIM_PORT}/_dsv4shim/health`);
const healthBody = await health.json();
check('health stays open for the readiness probe', health.status === 200 && healthBody.ok === true);
check('health leaks no spend, balance or config', !('model' in healthBody) && !('capUsd' in healthBody),
  JSON.stringify(healthBody));
// fetch() treats Host as a forbidden header and drops it, so this needs a raw request.
const reboundStatus = await new Promise((resolve) => {
  const rq = http.request({
    host: '127.0.0.1', port: SHIM_PORT, path: '/_dsv4shim/health', method: 'GET',
    headers: { host: 'evil.example.com' },
  }, (rs) => { rs.resume(); resolve(rs.statusCode); });
  rq.on('error', () => resolve(0));
  rq.end();
});
check('foreign Host header rejected (DNS rebinding)', reboundStatus === 403, `status=${reboundStatus}`);

const u = await (await fetch(`http://127.0.0.1:${SHIM_PORT}/_dsv4shim/usage`, {
  headers: { authorization: `Bearer ${SENTINEL}` },
})).json();
check('reports request count', u.requests > 0);
check('reports burn rate', typeof u.burn?.tokensPerMin === 'number');
check('reports cap', u.capUsd === 5);

// --- peak surcharge state, for the statusline ---------------------------------
// The statusline colours remaining credit red while the surcharge is charging. It must not
// re-derive that from its own clock, or it can disagree with what is actually being billed.
check('reports peak state', u.peak != null && typeof u.peak.active === 'boolean',
  JSON.stringify(u.peak));
check('peak multiplier agrees with active flag',
  u.peak.active === (u.peak.multiplier > 1),
  JSON.stringify({ active: u.peak.active, multiplier: u.peak.multiplier }));
check('peak windows are reported in UTC and in local hours',
  Array.isArray(u.peak.utcWindows) && Array.isArray(u.peak.localWindows) &&
  u.peak.utcWindows.length === u.peak.localWindows.length,
  JSON.stringify({ utc: u.peak.utcWindows, local: u.peak.localWindows }));
check('peak reports the host timezone for display', typeof u.peak.timezone === 'string' && u.peak.timezone.length > 0,
  String(u.peak.timezone));
// Local hours are display-only; the decision is UTC, so a machine with a wrong timezone is
// still billed and coloured correctly. Every local hour must be a valid 0-23 hour.
check('local window hours are valid clock hours',
  u.peak.localWindows.every(w => w.every(h => Number.isInteger(h) && h >= 0 && h < 24)),
  JSON.stringify(u.peak.localWindows));

// ----------------------------------------------------------------- new sub-routines

// --- classifier interceptor ---
// Both `classify_result` (tool name) and `shouldBlock` (its only parameter) must appear.
// The mock upstream records every body it sees in `seen`; we verify that NO such body
// arrived there (i.e. the shim short-circuited the request).
const beforeClassifier = seen.length;
const classReq = {
  model: 'deepseek-v4-flash',
  system: 'You are the safety classifier. Use classify_result and return shouldBlock.',
  tools: [{ name: 'classify_result', description: 'classify safety', input_schema: { properties: { shouldBlock: {} } } }],
  messages: [{ role: 'user', content: 'ls -la' }],
};
const classResp = await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
  method: 'POST',
  headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
  body: JSON.stringify(classReq),
});
const classBody = await classResp.json();
check('classifier mock returns 200', classResp.status === 200);
check('classifier mock tool_use is classify_result',
  classBody.content?.[0]?.name === 'classify_result');
check('classifier mock shouldBlock is false',
  classBody.content?.[0]?.input?.shouldBlock === false);
check('classifier mock was NOT forwarded to upstream',
  seen.length === beforeClassifier);

// Regression: a real bug found live on 2026-08-10. The matcher used to be a substring search
// over the WHOLE stringified body, which includes the entire resent conversation history —
// not just the current turn. A session that had ever discussed "classify_result" and
// "shouldBlock" in plain text (e.g. debugging this exact file) matched on EVERY subsequent
// request for the rest of that conversation, hijacking real replies with the canned mock.
// Confirmed on this box: one resumed session's history alone contained "classify_result"
// 11,315 times, and every one of its ~34,000 requests over the following day was intercepted.
// A normal coding turn whose HISTORY merely mentions both words as text (no actual
// classify_result tool defined on the CURRENT request) must be forwarded normally.
const beforePolluted = seen.length;
const pollutedReq = {
  model: 'deepseek-v4-flash',
  system: 'You are Claude Code.',
  messages: [
    { role: 'user', content: 'how does the shim\'s classify_result / shouldBlock interceptor work?' },
    { role: 'assistant', content: 'It matches on classify_result (tool name) and shouldBlock (its parameter)...' },
    { role: 'user', content: 'ok now fix the bug we just found in shouldBlock handling' },
  ],
  // No classify_result tool defined on THIS request — a real coding turn's toolset.
  tools: [{ name: 'Bash', description: 'run a shell command', input_schema: { properties: { command: {} } } }],
};
await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
  method: 'POST', headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
  body: JSON.stringify(pollutedReq),
});
check('a real turn whose HISTORY mentions classify_result/shouldBlock as text is NOT hijacked',
  seen.length === beforePolluted + 1, `forwarded=${seen.length - beforePolluted}`);

// --- classifier V2: retry-with-backoff on a stalled/reset upstream connection ---
// This is the incident the shim previously had no defense against: auto-mode's two-stage
// XML classifier runs against Claude Code's own ~60s fail-closed budget, and a single
// stalled DeepSeek connection used to surface straight through as a 502 (the harness then
// denies the tool call, "temporarily unavailable"). The mock fails the first two attempts
// outright (destroyed connection, no response) and succeeds on the third; the shim must
// retry transparently and the client must see a normal 200, not an error.
const retryBefore = seen.length;
const retryReq = {
  model: 'deepseek-v4-pro-medium', max_tokens: 100,
  system: 'permission classifier decision RETRY_TEST_MARKER',
  messages: [{ role: 'user', content: 'rm -rf /tmp/x' }],
};
const retryResp = await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
  method: 'POST', headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
  body: JSON.stringify(retryReq),
});
check('classifier V2: transient upstream failures are retried transparently (200, not 502)',
  retryResp.status === 200, `got ${retryResp.status}`);
check('classifier V2: exactly 3 upstream attempts were made (2 failures + 1 success)',
  seen.length === retryBefore + 3, `got ${seen.length - retryBefore}`);

// --- classifier V2: full retry exhaustion (widened 2026-08-13 from 3 to 5 attempts) ---
const exhaustBefore = seen.length;
const exhaustReq = {
  model: 'deepseek-v4-pro-medium', max_tokens: 100,
  system: 'permission classifier decision EXHAUST_TEST_MARKER',
  messages: [{ role: 'user', content: 'rm -rf /tmp/y' }],
};
const exhaustResp = await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
  method: 'POST', headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
  body: JSON.stringify(exhaustReq),
});
check('classifier V2: exhausts all 5 attempts (not the old 3) before giving up',
  seen.length === exhaustBefore + 5, `got ${seen.length - exhaustBefore}`);
check('classifier V2: gives up cleanly with an error after exhaustion, never hangs',
  exhaustResp.status >= 500, `got ${exhaustResp.status}`);

// --- classifier V2: forced to minimal effort regardless of heuristic escalation ---
// CONFIRMED LIVE BUG, fixed 2026-08-13: real classifier requests carry the session's own
// MAIN model name (not a Haiku alias), so they never hit the slot:background shortcut and
// fell through to the SAME long+keywords heuristic as regular chat -- caught live hitting
// effort=ultra repeatedly on real classifier traffic, almost certainly why classifier calls
// were timing out under DeepSeek's peak-load latency (an "ultra" response takes far longer
// than a trivial yes/no check). Reuses the exact same hardPrompt that provably escalates
// regular traffic to 'ultra' above, but tagged as classifier-shaped -- must come out 'none'.
const classifierHardReq = {
  model: 'deepseek-v4-flash', max_tokens: 200,
  system: 'permission classifier decision: shouldBlock this command?',
  messages: [{ role: 'user', content: hardPrompt }],
};
const classifierHardResp = await (await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
  method: 'POST', headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
  body: JSON.stringify(classifierHardReq),
})).json();
check('classifier traffic forced to minimal effort even with heuristic-escalating content',
  seen[seen.length - 1].body.thinking?.type === 'disabled',
  JSON.stringify(seen[seen.length - 1].body.thinking ?? seen[seen.length - 1].body.output_config));

// --- environment sanitizer ---
// Send a request whose system contains is_background: true and degraded_mode: true;
// the shim must rewrite them to false BEFORE forwarding to upstream.
const envReq = {
  model: 'deepseek-v4-flash',
  system: 'You are Claude Code.\n<environment_context>\n  is_background: true\n  degraded_mode: true\n</environment_context>',
  messages: [{ role: 'user', content: 'hi' }],
};
await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
  method: 'POST', headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
  body: JSON.stringify(envReq),
});
const envSeen = seen[seen.length - 1].body;
check('env sanitizer: is_background rewritten to false upstream',
  !envSeen.system.includes('is_background: true') && envSeen.system.includes('is_background: false'));
check('env sanitizer: degraded_mode rewritten to false upstream',
  !envSeen.system.includes('degraded_mode: true') && envSeen.system.includes('degraded_mode: false'));

// --- model mapper ---
// claude-3-5-haiku must be rewritten to the configured DeepSeek model BEFORE forwarding.
const beforeMapping = seen.length;
const mappedReq = {
  model: 'claude-3-5-haiku-20241022',
  system: 'topic detection', messages: [{ role: 'user', content: 'name the window' }],
};
await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
  method: 'POST', headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
  body: JSON.stringify(mappedReq),
});
check('model mapper: claude-3-5-haiku forwarded as deepseek-* to upstream',
  seen.length === beforeMapping + 1 &&
  /deepseek/i.test(seen[seen.length - 1].body.model) &&
  !/claude-3-5-haiku/.test(seen[seen.length - 1].body.model));

// Regression: cfg.fastModel used to be undefined, so modelMapper fell through to cfg.model
// (the real "deepseek-v4-flash" string) — which resolveModel() then slots as "main" (its own
// sentinel), landing haiku/background/compaction traffic on effort:high instead of
// effort:none. That is a ~25-50x cost inflation for traffic that never needed to think at
// all. Correct behavior: mapped requests carry thinking:disabled (the shim's effort:none
// encoding), proving they landed on the background slot.
check('model mapper: old haiku traffic lands on the cheap background profile, not main',
  seen[seen.length - 1].body.model === 'deepseek-v4-flash' &&
  seen[seen.length - 1].body.output_config?.effort === 'low',
  JSON.stringify({ model: seen[seen.length - 1].body.model, effort: seen[seen.length - 1].body.output_config }));

// Allowlist design (2026-08-13): current flagships -> main; EVERYTHING else Anthropic-shaped
// (any Haiku generation, any non-current Sonnet/Opus/Fable generation, any future unlisted
// name) -> background. This is the actual behavior change from the old blocklist approach —
// claude-3-5-sonnet/claude-3-opus used to map to main, now correctly default to background
// since they aren't current flagships.
// Opus/Fable tier default is 'max' (not the flat slot default 'high') when the client sends
// no explicit effort field — see decideEffort()'s tierDefault. Real Claude Code CLI traffic is
// unaffected in practice (it always sends output_config.effort itself, per _autoSemantics),
// so this only matters for a Desktop/Cowork-style client that leaves it unset, which is what
// `msg()` here simulates.
r = await send({ ...msg(), model: 'claude-opus-5-20251101' });
check('model mapper: current flagship (opus-5) -> main, tier default high (thinking enabled)',
  r.last?.body?.output_config?.effort === 'high' && r.last?.body?.thinking?.type !== 'disabled',
  JSON.stringify({ output_config: r.last?.body?.output_config, thinking: r.last?.body?.thinking }));

// Sonnet's tier default is 'max' — it runs on the cheaper V4 Flash, so it is given the
// deeper reasoning budget rather than the shallower one.
r = await send({ ...msg(), model: 'claude-sonnet-5-20251101' });
check('model mapper: current flagship (sonnet-5) -> main, tier default max', r.last?.body?.output_config?.effort === 'max');

r = await send({ ...msg(), model: 'claude-3-5-sonnet-20241022' });
check('model mapper: non-current sonnet (3-5) -> background, NOT main (was the old behavior)',
  r.last?.body?.model === 'deepseek-v4-flash' && r.last?.body?.output_config?.effort === 'low',
  JSON.stringify({ model: r.last?.body?.model, effort: r.last?.body?.output_config }));

r = await send({ ...msg(), model: 'claude-3-opus-20240229' });
check('model mapper: non-current opus (3) -> background, NOT main (was the old behavior)',
  r.last?.body?.model === 'deepseek-v4-flash' && r.last?.body?.output_config?.effort === 'low',
  JSON.stringify({ model: r.last?.body?.model, effort: r.last?.body?.output_config }));

r = await send({ ...msg(), model: 'claude-sonnet-9-hypothetical-future-model' });
check('model mapper: unlisted future generation defaults safely to background, not main',
  r.last?.body?.model === 'deepseek-v4-flash' && r.last?.body?.output_config?.effort === 'low',
  JSON.stringify({ model: r.last?.body?.model, effort: r.last?.body?.output_config }));

// --- response sanitizer (Bash tool_use with is_background: true) ---
// The mock upstream returns a Bash tool_use block with is_background: true when the user
// prompt is exactly 'mark for bash test'. The shim must rewrite is_background to false
// because the command `ls -la` has no background syntax.
const bashReq = {
  model: 'deepseek-v4-flash',
  system: 'x',
  messages: [{ role: 'user', content: 'mark for bash test' }],
};
const bashResp = await (await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
  method: 'POST', headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
  body: JSON.stringify(bashReq),
})).json();
const bashTool = bashResp.content?.find(b => b.type === 'tool_use' && b.name === 'Bash');
check('response sanitizer: Bash is_background forced false when no bg syntax',
  bashTool && bashTool.input.is_background === false);

// Streaming variant: same request with stream:true — sanitizer must also rewrite the
// streamed content_block events. The mock's partial_json is double-JSON-encoded in the
// SSE payload (the chunk is itself a JSON string), so we look for the JSON-escaped form
// `is_background\":true|false`.
const bashStreamReq = { ...bashReq, stream: true };
const bashStreamBody = await (await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
  method: 'POST', headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
  body: JSON.stringify(bashStreamReq),
})).text();
const streamHasTrue = /is_background\\":\s*true/.test(bashStreamBody);
const streamHasFalse = /is_background\\":\s*false/.test(bashStreamBody);
const streamOk = !streamHasTrue && streamHasFalse;
check('response sanitizer: streaming Bash is_background rewritten', streamOk,
  streamOk ? '' : `body:\n${bashStreamBody}`);

// Regression: a Bash command whose own text contains `"is_background":true` must not have
// that occurrence mangled by the sanitizer — only the actual is_background key changes.
const corruptionReq = { model: 'deepseek-v4-flash', system: 'x', stream: true,
  messages: [{ role: 'user', content: 'mark for bash corruption test' }] };
const corruptionBody = await (await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
  method: 'POST', headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
  body: JSON.stringify(corruptionReq),
})).text();
const jsonLine = corruptionBody.split('\n').find(l => l.startsWith('data:') && l.includes('input_json_delta'));
const parsedInput = jsonLine ? JSON.parse(JSON.parse(jsonLine.slice(5)).delta.partial_json) : null;
check('response sanitizer: is_background key rewritten to false',
  parsedInput?.is_background === false, JSON.stringify(parsedInput));
check('response sanitizer: literal "is_background":true INSIDE the command string survives untouched',
  parsedInput?.command === 'echo \'{"is_background":true}\' > /tmp/config.json', parsedInput?.command);

// --- Claude Desktop/Cowork: /v1/models discovery ---
console.log('\n\x1b[1mdesktop: /v1/models discovery\x1b[0m');

{
  const r = await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/models`, {
    headers: { authorization: `Bearer ${SENTINEL}` },
  });
  const j = await r.json();
  check('GET /v1/models: 200 with Bearer auth', r.status === 200);
  check('GET /v1/models: returns exactly the 4 logical tiers', Array.isArray(j.data) && j.data.length === 4,
    JSON.stringify(j.data));
  check('GET /v1/models: every entry is Anthropic-shaped (type:model, id, display_name)',
    j.data.every(m => m.type === 'model' && typeof m.id === 'string' && typeof m.display_name === 'string'),
    JSON.stringify(j.data));
  const ids = j.data.map(m => m.id);
  check('GET /v1/models: includes the configured tier IDs (opus/sonnet/fable/haiku)',
    ids.includes(cfg.desktop?.tierModelIds?.opus ?? 'claude-opus-5') &&
    ids.includes(cfg.desktop?.tierModelIds?.sonnet ?? 'claude-sonnet-5') &&
    ids.includes(cfg.desktop?.tierModelIds?.fable ?? 'claude-fable-5') &&
    ids.includes(cfg.desktop?.tierModelIds?.haiku ?? 'claude-haiku-4-5-20251001'),
    JSON.stringify(ids));
  check('GET /v1/models: does NOT passthrough to the real DeepSeek catalogue (no deepseek-* id)',
    !ids.some(id => /deepseek/i.test(id)), JSON.stringify(ids));

  // Second auth scheme required by the doc: x-api-key, not just Authorization: Bearer.
  const r2 = await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/models`, { headers: { 'x-api-key': SENTINEL } });
  check('GET /v1/models: 200 with x-api-key auth', r2.status === 200);

  const r3 = await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/models`);
  check('GET /v1/models: 401 with no auth at all', r3.status === 401);
}

// --- Desktop/Cowork: per-tier reasoning-effort defaults ---
console.log('\n\x1b[1mdesktop: per-tier reasoning defaults\x1b[0m');

r = await send({ ...msg(), model: cfg.desktop?.tierModelIds?.fable ?? 'claude-fable-5' });
check('Fable tier with no client effort -> max',
  r.last?.body?.output_config?.effort === 'max', JSON.stringify(r.last?.body?.output_config));

r = await send({ ...msg(), model: cfg.desktop?.tierModelIds?.opus ?? 'claude-opus-5' });
check('Opus tier with no client effort -> high',
  r.last?.body?.output_config?.effort === 'high', JSON.stringify(r.last?.body?.output_config));

r = await send({ ...msg(), model: cfg.desktop?.tierModelIds?.sonnet ?? 'claude-sonnet-5' });
check('Sonnet tier with no client effort -> max',
  r.last?.body?.output_config?.effort === 'max', JSON.stringify(r.last?.body?.output_config));

r = await send({ ...msg(), model: cfg.desktop?.tierModelIds?.haiku ?? 'claude-haiku-4-5-20251001' });
check('Haiku tier -> flash at high (a deliberate pick, unlike background traffic)',
  r.last?.body?.model === 'deepseek-v4-flash' && r.last?.body?.output_config?.effort === 'high',
  JSON.stringify({ model: r.last?.body?.model, effort: r.last?.body?.output_config }));

// A client-specified effort always overrides the tier default, for any tier.
r = await send({ ...msg(), model: cfg.desktop?.tierModelIds?.opus ?? 'claude-opus-5', output_config: { effort: 'low' } });
check('Opus tier: explicit client effort (low) overrides the tier default (high)',
  r.last?.body?.output_config?.effort === 'low', JSON.stringify(r.last?.body?.output_config));

// Tiers now split across TWO real models. The capable tiers (opus/fable) run on V4 Pro; the
// cheap ones (sonnet/haiku) stay on V4 Flash, which is ~3x cheaper on every axis. This
// replaces the former single-model guarantee: the point is no longer that nothing reaches
// Pro, but that each tier reaches exactly the model it was assigned and no other.
{
  const expectPerTier = {
    fable: 'deepseek-v4-pro',
    opus: 'deepseek-v4-pro',
    sonnet: 'deepseek-v4-flash',
    haiku: 'deepseek-v4-flash',
  };
  const fallbackIds = {
    fable: 'claude-fable-5', opus: 'claude-opus-5',
    sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5-20251001',
  };
  const results = {};
  for (const [tier, want] of Object.entries(expectPerTier)) {
    const id = cfg.desktop?.tierModelIds?.[tier] ?? fallbackIds[tier];
    const rr = await send({ ...msg(), model: id });
    results[tier] = rr.last?.body?.model;
    check(`tier ${tier} -> ${want}`, results[tier] === want, JSON.stringify(results));
  }
  // Only the two configured models may ever be billed. A typo in upstreamModels that let a
  // sentinel or an unpriced third model through would otherwise bill silently at $0, since
  // ratesFor() returns zeros for anything it has no rate for.
  const allowed = new Set(Object.keys(cfg.rates || {}).filter(k => !k.startsWith('_') && k !== 'effectiveFrom' && k !== 'source'));
  check('every tier lands on a model that has configured rates',
    Object.values(results).every(m => allowed.has(m)),
    `got ${JSON.stringify(results)} allowed ${JSON.stringify([...allowed])}`);
}

// --- CLI tier sentinels ----------------------------------------------------------
// Desktop identifies a tier by a Claude-looking model ID; the CLI cannot, because reroute
// points ANTHROPIC_DEFAULT_*_MODEL at sentinels. These per-tier sentinels are what carry the
// tier through for CLI traffic — the single largest source of requests. If they stopped
// resolving, every CLI tier would quietly land on one model and one effort level.
console.log('\n\x1b[1mCLI tier sentinels\x1b[0m');
{
  const cases = [
    ['deepseek-v4-pro-medium', 'deepseek-v4-pro',   'medium'],
    ['deepseek-v4-pro-high',   'deepseek-v4-pro',   'high'],
    ['deepseek-v4-pro-max',    'deepseek-v4-pro',   'max'],
    ['deepseek-v4-flash-max',  'deepseek-v4-flash', 'max'],
    ['deepseek-v4-flash-high', 'deepseek-v4-flash', 'high'],
    ['deepseek-v4-flash-low',  'deepseek-v4-flash', 'low'],
  ];
  for (const [profile, wantModel, wantEffort] of cases) {
    const rr = await send({ ...msg(), model: profile });
    check(`${profile} -> ${wantModel} @ ${wantEffort}`,
      rr.last?.body?.model === wantModel && rr.last?.body?.output_config?.effort === wantEffort,
      JSON.stringify({ model: rr.last?.body?.model, effort: rr.last?.body?.output_config?.effort }));
  }

  // The profile NAME states the real model and effort. That is the whole point: the model
  // picker renders it raw, so an opaque sentinel leaves no way to tell what an entry connects
  // to. Guard the naming, or the next rename quietly makes the menu meaningless again.
  for (const [profile, wantModel, wantEffort] of cases) {
    check(`${profile} names its own model and effort`,
      profile.startsWith(wantModel) && profile.endsWith(wantEffort),
      profile);
  }

  const sub = await send({ ...msg(), model: 'deepseek-v4-flash-sub' });
  check('subagent profile runs on flash', sub.last?.body?.model === 'deepseek-v4-flash',
    String(sub.last?.body?.model));

  // A deliberately chosen level still beats the profile default.
  const pinned = await send({ ...msg(), model: 'deepseek-v4-pro-max', output_config: { effort: 'low' } });
  check('explicit effort still overrides a profile default',
    pinned.last?.body?.output_config?.effort === 'low',
    JSON.stringify(pinned.last?.body?.output_config));
}

// --- ultracode swarm hint --------------------------------------------------------
console.log('\n\x1b[1multracode swarm hint\x1b[0m');
{
  const sysTextOf = (res) => (typeof res.last?.body?.system === 'string'
    ? res.last.body.system
    : (res.last?.body?.system || []).map(b => b?.text || '').join('\n'));
  const sid = 'swarm-session-1';

  // Ordinary traffic must NOT carry it — it is noise outside a fan-out, and it would sit in
  // the cached prefix of every unrelated session.
  const plain = await send(msg({ metadata: { user_id: 'unrelated-session' } }));
  check('no swarm hint on ordinary turns', !/PARALLEL DISPATCH:/.test(sysTextOf(plain)));

  // xhigh marks the session as ultracode (see markUltracode).
  await send(msg({ metadata: { user_id: sid }, output_config: { effort: 'xhigh' } }));
  const after = await send(msg({ metadata: { user_id: sid } }));
  check('swarm hint appears on main-slot turns once ultracode is engaged',
    /PARALLEL DISPATCH:/.test(sysTextOf(after)), sysTextOf(after).slice(-200));
  check('swarm hint asks for one message carrying many Task blocks',
    /SINGLE assistant message/.test(sysTextOf(after)));

  // Applied once: repeating it would waste prefix and add nothing.
  const again = await send(msg({ metadata: { user_id: sid }, system: 'base prompt' }));
  const n = (sysTextOf(again).match(/PARALLEL DISPATCH:/g) || []).length;
  check('swarm hint applied exactly once', n === 1, `x${n}`);

  // Subagents must not be told to swarm, or fan-outs nest inside fan-outs.
  const subr = await send({ ...msg({ metadata: { user_id: sid } }), model: 'deepseek-v4-flash-sub' });
  check('subagent turns never carry the swarm hint', !/PARALLEL DISPATCH:/.test(sysTextOf(subr)));
}

// --- temporal anchor -------------------------------------------------------------
// Claude Code sends no calendar date and DeepSeek has no clock, so without this the model
// dates "today" from whatever the transcript last mentioned — wrong weekday, wrong
// days-remaining, and wrong scheduling the moment it acts on either.
console.log('\n\x1b[1mtemporal anchor\x1b[0m');
{
  const sysTextOf = (res) => (typeof res.last?.body?.system === 'string'
    ? res.last.body.system
    : (res.last?.body?.system || []).map(b => b?.text || '').join('\n'));

  const r1 = await send(msg());
  const sys1 = sysTextOf(r1);
  check('system prompt carries a current-date anchor', /CURRENT DATE:/.test(sys1), sys1.slice(0, 240));

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  check('anchor states the real current date', sys1.includes(todayIso), `want ${todayIso} in: ${sys1.slice(-240)}`);
  check('anchor tells the model not to date itself from the transcript',
    /never .{0,40}infer today/i.test(sys1), sys1.slice(-240));

  // Cache safety, and the reason the anchor is day-granular rather than a timestamp:
  // DeepSeek keys its cache on the prompt PREFIX and prices a hit ~30x below a miss, so an
  // anchor that changed between two requests in the same day would re-cache every whole
  // conversation on every turn — a large, silent cost regression.
  const r2 = await send(msg({}, 'an entirely different question'));
  const a1 = (sys1.match(/CURRENT DATE:[^\n]*/) || [''])[0];
  const a2 = ((sysTextOf(r2)).match(/CURRENT DATE:[^\n]*/) || [''])[0];
  check('anchor is byte-identical within one day (prefix cache preserved)', a1 === a2, `${a1}\n vs \n${a2}`);

  // Appending twice would both waste prefix and read as contradictory if the day rolled
  // between passes, so the marker is idempotent.
  const pre = 'You are a helpful assistant.';
  const r3 = await send(msg({ system: pre }));
  const occurrences = (sysTextOf(r3).match(/CURRENT DATE:/g) || []).length;
  check('anchor applied exactly once to an existing system prompt', occurrences === 1, `x${occurrences}`);
  check('existing system prompt is preserved, not replaced', sysTextOf(r3).startsWith(pre), sysTextOf(r3).slice(0, 80));
}

// --- failure rows reach the ledger -----------------------------------------------
// The ledger previously recorded only successes, which made "100% status 200" a tautology
// rather than evidence of a healthy upstream and hid every 429/503 from dsv4shim-usage.
console.log('\n\x1b[1mledger records failures\x1b[0m');
{
  const readLedger = () => fs.readFileSync(path.join(DATA_DIR, 'usage.jsonl'), 'utf8')
    .split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
  const before = readLedger().length;
  const rr = await send(msg({ system: 'UPSTREAM_FAIL_MARKER' }));
  await new Promise(res => setTimeout(res, 200));
  const rows = readLedger();
  const added = rows.slice(before);
  check('a non-2xx upstream response produces a ledger row', added.length >= 1, `added ${added.length}`);
  check('the failure row carries the real upstream status',
    added.some(x => x.status === rr.status && x.status >= 400), JSON.stringify(added.map(x => x.status)));
  check('the failure row names the model that was attempted',
    added.every(x => typeof x.model === 'string' && x.model.startsWith('deepseek-')),
    JSON.stringify(added.map(x => x.model)));
}

// --- concurrency: two simultaneous streaming requests must not mix content ---
console.log('\n\x1b[1mconcurrency: isolated simultaneous streams\x1b[0m');

{
  const streamReq = (marker) => ({
    model: 'deepseek-v4-pro-medium', max_tokens: 100, stream: true,
    messages: [{ role: 'user', content: marker }],
  });
  const fetchStream = async (marker) => {
    const res = await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
      body: JSON.stringify(streamReq(marker)),
    });
    return res.text();
  };
  // Both requests hit the same mock handler concurrently; the mock's own response content is
  // identical either way ("ok"), so this test's job is specifically to confirm the shim's
  // per-connection SseSanitizer/UsageSniffer state (this.buf/this.held/etc, all constructed
  // fresh per call to handleMessages) never cross-writes onto the other response's socket —
  // i.e. each concurrent res.write() lands only on its own connection.
  const [bodyA, bodyB] = await Promise.all([fetchStream('concurrent-A'), fetchStream('concurrent-B')]);
  const wellFormed = (b) => b.includes('message_start') && b.includes('message_stop') &&
    !b.includes('undefined') && b.split('event: message_stop').length === 2;
  check('concurrent stream A is well-formed and complete', wellFormed(bodyA), bodyA.slice(0, 200));
  check('concurrent stream B is well-formed and complete', wellFormed(bodyB), bodyB.slice(0, 200));
  check('concurrent streams did not get concatenated onto one connection',
    bodyA !== bodyB || bodyA.split('event: message_start').length === 2);
}

console.log('\n\x1b[1mlocal traffic gate\x1b[0m');
{
  trafficActive = 0; maxTrafficActive = 0; backgroundTrafficActive = 0; maxBackgroundTrafficActive = 0;
  const mainBody = { model: 'deepseek-v4-pro-medium', max_tokens: 100, system: 'TRAFFIC_MAIN_MARKER', messages: [{ role: 'user', content: 'parallel' }] };
  const bgBody = { model: 'deepseek-v4-flash-low', max_tokens: 100000, system: 'TRAFFIC_BACKGROUND_MARKER', messages: [{ role: 'user', content: 'parallel' }] };
  const mainResults = await Promise.all(Array.from({ length: 4 }, () => send(mainBody)));
  check('main fan-out stays within two upstream lanes', mainResults.every(r => r.status === 200) && maxTrafficActive <= 2, String(maxTrafficActive));
  const bgStart = seen.length;
  const bgResults = await Promise.all(Array.from({ length: 4 }, () => send(bgBody)));
  const bgBodies = seen.slice(bgStart).map(x => x.body);
  check('background fan-out stays within one upstream lane', bgResults.every(r => r.status === 200) && maxBackgroundTrafficActive <= 1, String(maxBackgroundTrafficActive));
  check('background output budget is capped', bgBodies.every(x => x.max_tokens === 4096), JSON.stringify(bgBodies.map(x => x.max_tokens)));
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
if (fail) console.log('shim log:\n' + shimLog);

shim.kill(); mock.close(); visionMock.close();
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
