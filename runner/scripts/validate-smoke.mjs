#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCurrentMiniApp } from './layout-identity.mjs';

const ALLOWED_STATE_CHANGES = new Set([
  'form-submit',
  'timer-progress',
  'list-mutation',
  'toggle',
  'value-edit',
]);

function fail(message) { throw new Error(`invalid smoke evidence: ${message}`); }
function serialized(layout) { return JSON.stringify(layout); }
function contains(layout, value) { return serialized(layout).includes(String(value)); }

export function validateSmoke(projectDir) {
  const project = resolve(projectDir);
  const smoke = join(project, '.expo-fast/smoke');
  const paths = {
    manifest: join(project, '.expo-fast/manifest.json'),
    action: join(smoke, 'action.json'),
    before: join(smoke, 'layout-before.json'),
    after: join(smoke, 'layout-after.json'),
    restarted: join(smoke, 'layout-restarted.json'),
    screenshot: join(smoke, 'screenshot.jpeg'),
  };
  for (const [name, path] of Object.entries(paths)) if (!existsSync(path)) fail(`missing ${name}: ${path}`);

  const manifest = JSON.parse(readFileSync(paths.manifest, 'utf8'));
  const action = JSON.parse(readFileSync(paths.action, 'utf8'));
  const before = JSON.parse(readFileSync(paths.before, 'utf8'));
  const after = JSON.parse(readFileSync(paths.after, 'utf8'));
  const restarted = JSON.parse(readFileSync(paths.restarted, 'utf8'));
  if (action.result !== 'PASS') fail('action.result must equal PASS');
  if (action.manifestId !== manifest.id) fail(`manifestId ${action.manifestId} does not equal ${manifest.id}`);
  if (!ALLOWED_STATE_CHANGES.has(action.action?.category)) fail(`action.category must be a non-navigation state change (${[...ALLOWED_STATE_CHANGES].join(', ')})`);

  const assertion = action.assertion;
  if (!assertion?.target || assertion.before === undefined || assertion.after === undefined || assertion.restarted === undefined) fail('assertion requires target, before, after, and restarted');
  try {
    assertCurrentMiniApp(before, manifest.id, [assertion.target], 'layout-before');
    assertCurrentMiniApp(after, manifest.id, [assertion.target], 'layout-after');
    assertCurrentMiniApp(restarted, manifest.id, [assertion.target], 'layout-restarted');
  } catch (error) { fail(error.message); }
  for (const phase of ['before', 'after', 'restarted']) if (action.identityNode?.[phase] !== manifest.id) fail(`identityNode.${phase} must equal ${manifest.id}`);
  if (String(assertion.before) === String(assertion.after)) fail('assertion before and after must differ');
  if (String(assertion.after) !== String(assertion.restarted)) fail('assertion restarted must equal the post-mutation value');
  if (!contains(before, assertion.before)) fail(`layout-before does not contain asserted value ${assertion.before}`);
  if (!contains(after, assertion.after)) fail(`layout-after does not contain asserted value ${assertion.after}`);
  if (!contains(restarted, assertion.restarted)) fail(`layout-restarted does not contain asserted value ${assertion.restarted}`);
  return { result: 'PASS', manifestId: manifest.id, category: action.action.category, persistedAfterRestart: true, assertion };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(validateSmoke(process.argv[2] || '.'), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
