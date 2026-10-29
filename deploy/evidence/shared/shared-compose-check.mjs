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

for (const [kind, namespace, channel, deployer] of [
  ['dev', 'business_finlynq_dev_', 'business_dev', 'deploy/dev/deploy-dev.sh'],
  ['stage', 'business_finlynq_development_', 'business_stage', 'deploy/development/deploy-development.sh'],
]) {
  test(`${kind} resource boundary accepts only its private external scanner channel`, () => {
    const environment = { ...process.env, BUSINESS_FINLYNQ_SECRET_GID: '20001',
      BUSINESS_FINLYNQ_IMAGE_REVISION: '1'.repeat(40), FINLYNQ_SCANNER_CHANNEL: channel,
      BUSINESS_FINLYNQ_PGDATA_VOLUME: namespace + 'pgdata', BUSINESS_FINLYNQ_PRIVATE_NETWORK: namespace + 'private',
      BUSINESS_FINLYNQ_EGRESS_NETWORK: namespace + 'egress', BUSINESS_FINLYNQ_EDGE_NETWORK: namespace + 'edge',
      BUSINESS_FINLYNQ_RESTORE_DRILL_NETWORK: namespace + 'restore_drill' };
    const rendered = spawnSync('docker', ['compose', '--env-file', '.env.example', '-f', 'docker-compose.yml',
      '-f', 'deploy/evidence/shared/business-relay.yml', 'config', '--format', 'json'],
    { env: environment, encoding: 'utf8', maxBuffer: 4 * 1024 ** 2 });
    assert.equal(rendered.status, 0, rendered.stderr);
    const configuration = JSON.parse(rendered.stdout);
    const source = readFileSync(deployer, 'utf8');
    const start = source.indexOf('  if jq -e \'.volumes | has("shared_scanner_channel")\'');
    assert.ok(start > 0);
    const check = source.slice(start, source.indexOf('\n}\n\ndocument_provider_configuration_matches()', start));
    const run = value => spawnSync('bash', ['-euc', `fail(){ echo "$*" >&2; exit 1; }
shared_scanner_resource=""
expected_resources=("$fixture_namespace"pgdata "$fixture_namespace"private "$fixture_namespace"egress "$fixture_namespace"edge)
found_resources=()
${check}`], { env: { ...environment, fixture_namespace: namespace, rendered: JSON.stringify(value) }, encoding: 'utf8' });
    const good = run(configuration);
    assert.equal(good.status, 0, good.stderr);
    for (const mutate of [
      value => { value.volumes.shared_scanner_channel.name = 'finlynq_scanner_business_prod_v1'; },
      value => { value.volumes.shared_scanner_channel.external = false; },
      value => { value.services.evidence_scanner.volumes[0].read_only = false; },
      value => { value.services.app.volumes = [value.services.evidence_scanner.volumes[0]]; },
      value => { value.volumes.unrelated = { name: 'business_finlynq_pgdata', external: true }; },
    ]) {
      const changed = structuredClone(configuration); mutate(changed);
      assert.notEqual(run(changed).status, 0);
    }
  });
}

for (const mode of ['local', 'shared']) {
  test(`${mode} rehearsal keeps every writable resource isolated`, () => {
    const project = 'business-finlynq-rehearsal-scanner-check';
    const environment = { ...process.env, BUSINESS_FINLYNQ_SECRET_GID: '20001',
      BUSINESS_FINLYNQ_IMAGE_REVISION: '1'.repeat(40), FINLYNQ_SCANNER_CHANNEL: 'business_stage',
      RELEASE_REHEARSAL_PROJECT: project };
    const files = ['-f', 'docker-compose.yml', '-f', 'deploy/release/docker-compose.rehearsal.yml'];
    if (mode === 'shared') files.push('-f', 'deploy/evidence/shared/business-relay.yml');
    const rendered = spawnSync('docker', ['compose', '--project-name', project,
      '--env-file', '.env.example', ...files, 'config', '--format', 'json'],
    { env: environment, encoding: 'utf8', maxBuffer: 4 * 1024 ** 2 });
    assert.equal(rendered.status, 0, rendered.stderr);
    const configuration = JSON.parse(rendered.stdout);
    const source = readFileSync('deploy/release/run-release.sh', 'utf8');
    const start = source.indexOf('  rehearsal_resources=');
    const end = source.indexOf('  [[ "$app_port"', start);
    assert.ok(start > 0 && end > start);
    const run = value => spawnSync('bash', ['-euc',
      `fail(){ echo "$*" >&2; exit 1; }
source deploy/evidence/shared/compose-contract.sh
${source.slice(start, end)}`],
    { env: { ...environment, rendered_compose: JSON.stringify(value), compose_project: project }, encoding: 'utf8' });
    const good = run(configuration);
    assert.equal(good.status, 0, good.stderr);
    const mutations = [
      value => { value.volumes.business_finlynq_pgdata.name = 'business_finlynq_pgdata'; },
      value => { value.volumes.business_finlynq_pgdata.external = true; },
      value => { value.networks.business_finlynq_private.name = 'business_finlynq_private'; },
      value => { value.networks.business_finlynq_private.external = true; },
    ];
    if (mode === 'shared') mutations.push(
      value => { value.volumes.shared_scanner_channel.name = 'finlynq_scanner_business_prod_v1'; },
      value => { value.volumes.shared_scanner_channel.external = false; },
      value => { value.services.evidence_scanner.volumes[0].read_only = false; },
      value => { value.services.app.volumes = [value.services.evidence_scanner.volumes[0]]; },
      value => { value.services.evidence_scanner.image = 'node:latest'; },
      value => { value.volumes.alias = { ...value.volumes.shared_scanner_channel }; },
    );
    for (const mutate of mutations) {
      const changed = structuredClone(configuration); mutate(changed);
      assert.notEqual(run(changed).status, 0);
    }
  });
}
