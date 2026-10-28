#!/usr/bin/env python3
"""Read-only shared-owner and optional Business-forwarder attestation. No secret reads."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
CLAM = 'clamav/clamav@sha256:f0954d679017eb6d48221e2b2be3ac5457bf278a844f39b672376f55a085f591'
NODE = 'node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf'
CHANNELS = ('business-prod', 'business-stage', 'business-dev', 'consult-dev', 'consult-dev2', 'consult-stage')
PROJECTS = {'business-finlynq': 'business-prod', 'business-finlynq-development': 'business-stage',
            'business-finlynq-dev': 'business-dev'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def docker(*args):
    return subprocess.run(['docker', *args], check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True, timeout=55).stdout.strip()


def inspect(*args):
    result = json.loads(docker(*args))
    require(len(result) == 1, 'ambiguous runtime identity')
    return result[0]


def container(project, service):
    ids = docker('ps', '--quiet', '--no-trunc', '--filter', f'label=com.docker.compose.project={project}',
                 '--filter', f'label=com.docker.compose.service={service}').splitlines()
    require(len(ids) == 1, f'{project}/{service} must have one running container')
    return inspect('inspect', ids[0])


def runtime(row, image, user, memory, cpus, pids):
    expected = inspect('image', 'inspect', image)
    host, config = row['HostConfig'], row['Config']
    require(row['Image'] == expected['Id'] and config['Image'] == image, 'pinned image differs')
    require(config['User'] == user and host['ReadonlyRootfs'], 'non-root read-only contract differs')
    require(host['CapDrop'] == ['ALL'] and not host.get('CapAdd') and not host.get('Privileged')
            and 'no-new-privileges:true' in host['SecurityOpt'], 'capability contract differs')
    require(not host.get('PortBindings') and not host.get('Devices'), 'device/port contract differs')
    require(host['Memory'] == memory and host['NanoCpus'] == cpus and host['PidsLimit'] == pids,
            'resource bounds differ')
    require(host['RestartPolicy']['Name'] == 'unless-stopped' and row['State']['Running'], 'restart/runtime differs')
    require(config.get('Env') == expected['Config'].get('Env'), 'unexpected runtime environment')
    return expected['Id']


def mounts(row, expected):
    observed = {m['Destination']: m for m in row['Mounts']}
    require(set(observed) == set(expected), 'unexpected mounted storage')
    for destination, (kind, name, writable) in expected.items():
        found = observed[destination]
        require(found['Type'] == kind and found['RW'] == writable, 'mount access differs')
        if kind == 'volume':
            require(found['Name'] == name, 'volume identity differs')
        else:
            digest = hashlib.sha256((HERE / name).read_bytes()).hexdigest()
            actual = docker('exec', row['Id'], 'sha256sum', destination).split()[0]
            require(actual == digest, 'running source/configuration differs')


def literal(file, start, stop, skip=2, indent=8):
    lines = (HERE / file).read_text().splitlines()
    first = lines.index(start) + skip
    last = lines.index(stop, first)
    return '\n'.join(line[indent:] for line in lines[first:last]).strip()


def attest(project=None, *, owner='finlynq-shared-scanner', prefix='finlynq_scanner'):
    # Isolated integration tests supply their own namespace through this Python
    # function. The installed CLI always verifies the fixed production owner.
    scanner = container(owner, 'scanner')
    image_id = runtime(scanner, CLAM, '100:101', 3 * 1024 ** 3, 2_000_000_000, 64)
    require(scanner['State'].get('Health', {}).get('Status') == 'healthy', 'shared engine is unhealthy')
    require(scanner['Config']['Healthcheck']['Test'] ==
            ['CMD', 'clamdscan', '--ping=1', '--config-file=/etc/clamav/clamd.conf'], 'engine health command differs')
    require(set(scanner['NetworkSettings']['Networks']) == {f'{prefix}_signature_egress_v1'},
            'shared engine has unexpected network access')
    network = inspect('network', 'inspect', f'{prefix}_signature_egress_v1')
    require(network['Driver'] == 'bridge' and not network['Internal'] and not network['EnableIPv6']
            and not network.get('Options') and network['Labels'].get('com.docker.compose.project') == owner
            and network['Labels'].get('com.docker.compose.network') == 'signature_egress'
            and set(network.get('Containers', {})) == {scanner['Id']}, 'signature network isolation differs')
    if prefix == 'finlynq_scanner':
        require(len(network['IPAM']['Config']) == 1 and
                network['IPAM']['Config'][0]['Subnet'] == '10.240.12.0/28', 'signature subnet differs')
    require(scanner['Config']['Entrypoint'] == ['/sbin/tini', '-g', '--', '/bin/sh', '-ec']
            and [s.strip() for s in scanner['Config']['Cmd']] ==
            [literal('compose.yml', '    command:', '    volumes:')], 'engine startup differs')
    require(scanner['HostConfig']['Tmpfs'] == {
        '/tmp': 'size=128m,mode=1777,noexec,nosuid,nodev',
        '/var/log/clamav': 'size=8m,uid=100,gid=101,mode=0700'}, 'engine tmpfs differs')
    mounts(scanner, {'/etc/clamav/clamd.conf': ('bind', 'clamd.conf', False),
                     '/var/lib/clamav': ('volume', f'{prefix}_signatures_v1', True),
                     '/upstream': ('volume', f'{prefix}_upstream_v1', True)})
    gateway = container(owner, 'gateway')
    runtime(gateway, NODE, '10001:10001', 128 * 1024 ** 2, 500_000_000, 32)
    require(gateway['HostConfig']['NetworkMode'] == 'none'
            and set(gateway['NetworkSettings']['Networks']) == {'none'}, 'gateway has network access')
    require(gateway['HostConfig'].get('GroupAdd') == ['101']
            and gateway['Config']['Entrypoint'] == ['node', '/opt/scanner/gateway.mjs']
            and not gateway['Config'].get('Cmd') and not gateway['HostConfig'].get('Tmpfs'),
            'gateway startup/access differs')
    require(gateway['State'].get('Health', {}).get('Status') == 'healthy'
            and gateway['Config']['Healthcheck']['Test'][:3] == ['CMD', 'node', '-e']
            and len(gateway['Config']['Healthcheck']['Test']) == 4
            and gateway['Config']['Healthcheck']['Test'][3].strip() ==
            literal('compose.yml', '      test:', '      interval: 30s', 5, 10), 'gateway health differs')
    mounts(gateway, {'/opt/scanner/gateway.mjs': ('bind', 'gateway.mjs', False),
                     '/upstream': ('volume', f'{prefix}_upstream_v1', False),
                     **{f'/channels/{c}': ('volume', f'{prefix}_{c.replace("-", "_")}_v1', True)
                        for c in CHANNELS}})
    docker('exec', gateway['Id'], 'node', '-e', """const fs=require('node:fs');
function check(p,uid,gid,mode,socket){const s=fs.lstatSync(p);
if(s.uid!==uid||s.gid!==gid||(s.mode&511)!==mode||!(socket?s.isSocket():s.isDirectory()))process.exit(1);}
for(const c of ['business-prod','business-stage','business-dev','consult-dev','consult-dev2','consult-stage']){
check('/channels/'+c,10001,10001,448,false);check('/channels/'+c+'/clamd.sock',10001,10001,384,true);}
check('/upstream',100,101,504,false);check('/upstream/clamd.sock',100,101,432,true);""")
    # Validate actual loaded signatures, not just file modification times.
    version = docker('exec', gateway['Id'], 'node', '-e', """const net=require('node:net'); const c=net.createConnection('/upstream/clamd.sock');
let r=''; const timer=setTimeout(()=>process.exit(1),5000);
c.on('error',()=>process.exit(1)); c.on('connect',()=>c.write('zVERSION\\0'));
c.on('data',b=>{r+=b.toString();if(r.length>2048)process.exit(1);if(!r.endsWith('\\0'))return;
const m=/^ClamAV [^/]+\\/\\d+\\/(.+)\\0$/.exec(r),d=m?Date.parse(m[1]+' UTC'):NaN;
if(!Number.isFinite(d)||d>Date.now()+300000||Date.now()-d>604800000)process.exit(1);
clearTimeout(timer);console.log(r.slice(0,-1));c.destroy();});""")
    inventory = docker('exec', scanner['Id'], 'sh', '-ec',
                       'for p in /var/lib/clamav/*.cvd /var/lib/clamav/*.cld; do '
                       '[ ! -f "$p" ] || stat -c "%n|%u|%g|%a|%Y" "$p"; done')
    signatures = []
    for line in inventory.splitlines():
        path, uid, gid, mode, modified = line.split('|')
        require(uid == '100' and gid == '101' and not int(mode, 8) & 0o022
                and int(modified) <= time.time() + 300, 'signature ownership/time differs')
        signatures.append({'path': path, 'uid': int(uid), 'gid': int(gid), 'mode': mode,
                           'modifiedAtUnixtime': int(modified)})
    require(signatures, 'signature database missing')
    result = {'schemaVersion': 1, 'product': 'business-finlynq', 'sharedContract': 'v1',
              'verifiedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
              'containerId': scanner['Id'], 'imageReference': CLAM, 'imageId': image_id,
              'runtimeUser': '100:101', 'readOnlyRootFilesystem': True, 'signatures': signatures,
              'loadedVersion': version, 'gatewayContainerId': gateway['Id']}
    if project:
        channel = PROJECTS.get(project)
        if project.startswith('business-finlynq-rehearsal-'):
            channel = 'business-stage'
        require(channel, 'unrecognized consumer project')
        relay = container(project, 'evidence_scanner')
        result['relayImageId'] = runtime(relay, NODE, '10001:10001', 64 * 1024 ** 2, 250_000_000, 32)
        require(relay['State'].get('Health', {}).get('Status') == 'healthy', 'private forwarder unhealthy')
        require(not relay['HostConfig'].get('Tmpfs') and not relay['HostConfig'].get('GroupAdd'),
                'private forwarder has unexpected temporary storage or groups')
        require(relay['Config']['Healthcheck']['Test'][:3] == ['CMD', 'node', '-e']
                and len(relay['Config']['Healthcheck']['Test']) == 4
                and relay['Config']['Healthcheck']['Test'][3].strip() ==
                literal('business-relay.yml', '      test:', '      interval: 30s', 5, 10),
                'forwarder health command differs')
        networks = list(relay['NetworkSettings']['Networks'])
        require(len(networks) == 1, 'forwarder has unexpected network access')
        network = inspect('network', 'inspect', networks[0])
        require(network['Internal'] and network['Labels'].get('com.docker.compose.project') == project
                and network['Labels'].get('com.docker.compose.network') == 'business_finlynq_evidence',
                'forwarder network is not the consumer private evidence network')
        require(relay['Config']['Entrypoint'] == ['node', '--input-type=module', '-e']
                and [s.strip() for s in relay['Config']['Cmd']] ==
                [literal('business-relay.yml', '    command:', '    environment: !reset {}')],
                'forwarder protocol differs')
        mounts(relay, {'/run/finlynq-scanner': ('volume', f'{prefix}_{channel.replace("-", "_")}_v1', False)})
        result.update(relayContainerId=relay['Id'], consumerProject=project, channel=channel)
    return result


if __name__ == '__main__':
    try:
        require(len(sys.argv) <= 2, 'usage: attest.py [Business project]')
        print(json.dumps(attest(sys.argv[1] if len(sys.argv) == 2 else None)))
    except (ValueError, OSError, KeyError, subprocess.SubprocessError):
        print('Shared scanner attestation failed; inspect its reviewed identity, bounds and freshness.', file=sys.stderr)
        sys.exit(1)
