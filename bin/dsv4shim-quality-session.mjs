#!/usr/bin/env node
// One small SessionStart reminder makes the shipped quality skill discoverable without adding
// a prompt on every turn or spawning another model. The real checks happen in the async hook.
const input = await new Promise(resolve => {
  let s = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { s += c; });
  process.stdin.on('end', () => resolve(s));
});
let event = {};
try { event = JSON.parse(input || '{}'); } catch { /* hook input is optional */ }
const cwd = event.cwd || process.cwd();
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: `Coding quality workflow active for ${cwd}. For code changes, load the dsv4shim-code-quality skill; use the installed background quality gate as feedback, and route risky async/subagent/setup changes through deep-code-reviewer and lifecycle-auditor before using pre-push-verifier.`
  }
}));
