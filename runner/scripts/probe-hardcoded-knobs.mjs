import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ancestorMarker, appendedMarker, bodyText, captureRequest, claudeBinary,
  mcpNames, prepareWorkspace, systemText, toolNames,
} from './request-body-probe.mjs';
import { recordHarnessFacts } from './model-facts.mjs';

// The four promises the orchestrator hard codes and nothing could check. They
// are not configuration -- no file sets them, no flag overrides them -- so the
// only way to ask whether they do what their names say is to watch what Claude
// Code sends.
//
// Free and offline. Every request goes to a server on loopback, so this costs
// nothing and can be re-run after any Claude Code upgrade, which is exactly when
// an answer measured against one build stops describing the next.
const contrasts = [
  {
    name: 'disableClaudeMds',
    claim: 'CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 keeps a CLAUDE.md out of the turn',
    without: { flags: ['--tools', ''] },
    with: { flags: ['--tools', ''], env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' } },
    // Read across the whole request, because a project CLAUDE.md arrives among
    // the messages rather than in the system prompt. Looking only at system
    // reports the walk as already disabled, which is the right answer for the
    // wrong reason.
    observe: (capture) => (bodyText(capture.request).includes(ancestorMarker) ? 'present' : 'absent'),
    holds: (before, after) => before === 'present' && after === 'absent',
  },
  {
    name: 'toolsNone',
    claim: "--tools '' leaves the turn with no tools",
    without: { flags: [] },
    with: { flags: ['--tools', ''] },
    observe: (capture) => `${toolNames(capture.request).length} tools`,
    holds: (before, after) => before !== '0 tools' && after === '0 tools',
  },
  {
    name: 'strictMcpConfig',
    claim: '--strict-mcp-config ignores MCP servers this run did not pass in',
    // Contrasted against --mcp-config on its own, because that is the mistake
    // waiting to be made: an empty --mcp-config does not displace a project's
    // .mcp.json, so crediting it with the isolation would be wrong.
    without: { flags: ['--tools', '', '--mcp-config', '{"mcpServers":{}}'] },
    with: { flags: ['--tools', '', '--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config'] },
    observe: (capture) => (mcpNames(capture).length ? mcpNames(capture).join(',') : 'none'),
    holds: (before, after) => before !== 'none' && after === 'none',
  },
  {
    name: 'appendSystemPromptFile',
    claim: '--append-system-prompt-file puts the file into the system prompt',
    without: { flags: ['--tools', ''] },
    with: { flags: ['--tools', '', '--append-system-prompt-file', './appended.txt'] },
    observe: (capture) => (systemText(capture.request).includes(appendedMarker) ? 'present' : 'absent'),
    holds: (before, after) => before === 'absent' && after === 'present',
  },
];

async function main() {
  const workspace = prepareWorkspace();
  const measuredAt = new Date().toISOString();
  const measured = {};
  let held = 0;
  try {
    for (const contrast of contrasts) {
      const before = await captureRequest({ ...contrast.without, cwd: workspace });
      const after = await captureRequest({ ...contrast.with, cwd: workspace });
      if (!before.request || !after.request) {
        // Worth failing loudly on. A run that captured nothing looks exactly
        // like a knob that changed nothing, and reading one as the other is the
        // failure this whole suite exists to prevent.
        throw new Error(
          `${contrast.name}: Claude Code sent no request (${before.requestCount} / ${after.requestCount} captured).\n`
          + `  exit ${before.exitCode} / ${after.exitCode}\n  ${(after.output || before.output).split('\n')[0]}`,
        );
      }
      const seenWithout = contrast.observe(before);
      const seenWith = contrast.observe(after);
      const status = contrast.holds(seenWithout, seenWith) ? 'effective' : 'unverifiable';
      if (status === 'effective') held += 1;
      measured[contrast.name] = {
        status,
        claim: contrast.claim,
        evidence: `without: ${seenWithout}; with: ${seenWith}`,
        measuredAt,
      };
      console.log(`${status === 'effective' ? '✓' : '✗'} ${contrast.name}`);
      console.log(`    ${contrast.claim}`);
      console.log(`    without: ${seenWithout} · with: ${seenWith}`);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
  recordHarnessFacts(measured);
  console.log(`\n${held} of ${contrasts.length} hard-coded knobs do what their name says. Recorded in .local/models-cache.json.`);
  console.log('Re-run after a Claude Code upgrade: these answers describe one build.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error.message || error);
    console.error(`  claude binary: ${claudeBinary()}`);
    process.exitCode = 1;
  });
}
