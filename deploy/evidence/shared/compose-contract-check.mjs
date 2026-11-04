import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('protected deployment mode selects only the fixed consumer channels', t => {
  const directory = mkdtempSync(`${tmpdir()}/scanner-mode-`);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const environment = `${directory}/compose.env`;
  const run = (setting, project) => {
    writeFileSync(environment, setting);
    return spawnSync('bash', ['-ec', `source deploy/evidence/shared/compose-contract.sh
scanner_compose_contract "$1" "$2" "$3"
printf '%s\\n' "$scanner_mode" "\${scanner_environment_values[@]}" "\${scanner_files[@]}"`,
    'scanner-check', environment, project, process.cwd()], { encoding: 'utf8' });
  };
  assert.equal(run('', 'business-finlynq').stdout.trim(), 'local');
  for (const [project, channel] of Object.entries({ 'business-finlynq': 'business_prod',
    'business-finlynq-development': 'business_stage', 'business-finlynq-dev': 'business_dev',
    'business-finlynq-rehearsal-test': 'business_stage', 'business-finlynq-build-test': 'business_stage' })) {
    const result = run('BUSINESS_FINLYNQ_SCANNER_MODE=shared\n', project);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`FINLYNQ_SCANNER_CHANNEL=${channel}\\n`));
    assert.match(result.stdout, /business-relay.yml/);
  }
  for (const setting of ['BUSINESS_FINLYNQ_SCANNER_MODE=shared\nBUSINESS_FINLYNQ_SCANNER_MODE=local\n',
    'BUSINESS_FINLYNQ_SCANNER_MODE=none\n', 'BUSINESS_FINLYNQ_SCANNER_MODE=$(false)\n']) {
    assert.notEqual(run(setting, 'business-finlynq').status, 0);
  }
  assert.notEqual(run('BUSINESS_FINLYNQ_SCANNER_MODE=shared\n', 'unrelated-project').status, 0);
});
