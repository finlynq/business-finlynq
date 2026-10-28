import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('shared release accepts its actual Compose resources and refuses channel substitutions', () => {
  const environment = { ...process.env, BUSINESS_FINLYNQ_SECRET_GID: '20001',
    BUSINESS_FINLYNQ_IMAGE_REVISION: '1'.repeat(40), FINLYNQ_SCANNER_CHANNEL: 'business_prod' };
  const rendered = spawnSync('docker', ['compose', '--env-file', '.env.example', '-f', 'docker-compose.yml',
    '-f', 'deploy/evidence/shared/business-relay.yml', 'config', '--format', 'json'],
  { env: environment, encoding: 'utf8', maxBuffer: 4 * 1024 ** 2 });
  assert.equal(rendered.status, 0, rendered.stderr);
  const configuration = JSON.parse(rendered.stdout);
  assert.equal(configuration.volumes.business_finlynq_clamav, undefined);
  assert.equal(configuration.networks.business_finlynq_scanner_egress, undefined);
  const source = readFileSync('deploy/release/run-release.sh', 'utf8');
  const check = source.slice(source.indexOf('scanner_volume_name="'), source.indexOf('\ncompose_hash="'));
  assert.ok(check.includes('expected_scanner_channel'));
  const run = value => spawnSync('bash', ['-ec', `fail(){ echo "$*" >&2; exit 1; }\n${check}`],
    { env: { ...environment, rendered_compose: JSON.stringify(value), mode: 'release',
      scanner_image_reference: configuration.services.evidence_scanner.image }, encoding: 'utf8' });
  const good = run(configuration);
  assert.equal(good.status, 0, good.stderr);
  for (const mutate of [value => { value.volumes.shared_scanner_channel.external = false; },
    value => { value.volumes.shared_scanner_channel.name = 'finlynq_scanner_business_dev_v1'; },
    value => { value.services.evidence_scanner.volumes[0].read_only = false; }]) {
    const changed = structuredClone(configuration); mutate(changed);
    assert.notEqual(run(changed).status, 0);
  }
  const boundary = spawnSync(process.execPath, ['--env-file=.env.example',
    'scripts/operations/verify-compose-boundaries.mjs'], { env: { ...environment,
    COMPOSE_FILE: 'docker-compose.yml:deploy/evidence/shared/business-relay.yml' }, encoding: 'utf8' });
  assert.equal(boundary.status, 0, boundary.stderr);
});
