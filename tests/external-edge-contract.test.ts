import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const overlay = read("deploy/edge/docker-compose.external.yml");
const routes = read("deploy/edge/Caddyfile.business-external");
const verifier = read("deploy/edge/verify-external-edge.sh");
const reconciler = read("deploy/edge/reconcile-shared-edge.sh");
const release = read("deploy/release/run-release.sh");
const rollback = read("deploy/release/run-application-rollback.sh");
const monitor = read("deploy/monitoring/check-production.sh");
const developmentInstaller = read("deploy/development/install-development.sh");
const developmentDeployer = read("deploy/development/deploy-development.sh");

describe("externally managed edge contract", () => {
  it("makes the inherited edge profile incapable of owning a listener", () => {
    expect(overlay).toContain("profiles: !override [external-edge-disabled]");
    expect(overlay).toContain("ports: !reset []");
    expect(overlay).toContain("volumes: !reset []");
    expect(overlay).toContain("networks: !reset []");
    expect(overlay).toContain("network_mode: none");
    expect(overlay).toContain('entrypoint: ["/bin/false"]');
    expect(overlay).toMatch(/business_finlynq_edge:\s*\n\s*external: true/u);
  });

  it("publishes only the exact Business production and development routes", () => {
    expect(routes).toContain("business.finlynq.com {");
    expect(routes).toContain("dev.business.finlynq.com {");
    expect(routes).not.toContain("{$BUSINESS_FINLYNQ");
    expect(routes).toContain("reverse_proxy production-app:3000");
    expect(routes).toContain("reverse_proxy development-app:3000");
    expect(routes.match(/header_up -X-Business-Finlynq-Internal-Health/gu)).toHaveLength(2);
    expect(routes.match(/header_up -X-Business-Finlynq-Internal-Metrics/gu)).toHaveLength(2);
    expect(routes.match(/header_up -X-Request-Id/gu)).toHaveLength(2);
    expect(routes.match(/log_skip \/api\/document-storage\/callback\/\*/gu)).toHaveLength(2);
  });

  it("attests the exact EPM owner, image, listeners, mounts, networks, and loaded config", () => {
    for (const network of [
      "business_finlynq_edge",
      "business_finlynq_development_edge",
      "epm_finlynq_edge",
      "epm_finlynq_edge_egress",
    ]) {
      expect(verifier).toContain(network);
    }
    expect(verifier).toContain("external_project\" == epm-finlynq");
    expect(verifier).toContain("external_service\" == edge");
    expect(verifier).toContain("external_owner\" == epm-finlynq");
    expect(verifier).toContain("BUSINESS_FINLYNQ_EXTERNAL_EDGE_IMAGE_ID");
    expect(verifier).toContain("BUSINESS_FINLYNQ_EXTERNAL_EDGE_PUBLIC_IPV4S");
    expect(verifier).toContain("external edge host bindings differ from the protected public-IP and port inventory");
    expect(verifier).toContain("length == 5");
    expect(verifier).toContain("BUSINESS_FINLYNQ_EXTERNAL_EDGE_ROUTE_SHA256");
    expect(verifier).toContain("== 0:0:444");
    expect(verifier).toContain("BUSINESS_FINLYNQ_EXTERNAL_EDGE_ACTIVE_CONFIG_SHA256");
    expect(verifier).toContain("http://127.0.0.1:2019/config/");
  });

  it("supports a dev-first preflight without weakening full acceptance", () => {
    expect(verifier).toContain('[[ "$scope" == preflight || "$scope" == development || "$scope" == full ]]');
    expect(verifier).toContain("production preflight requires an empty Business Compose project");
    expect(verifier).toContain('if [[ "$scope" == full ]]; then');
    expect(verifier).toContain("backend_alias_is_present \"$production_project\"");
    expect(verifier).toContain('public_contract_is_valid "$production_hostname"');
    expect(verifier).toContain('public_contract_is_valid "$development_hostname"');
    expect(verifier).toContain('http_redirect_is_exact "$epm_hostname"');
    expect(verifier).toContain("positive edge log control was not observed");
    expect(verifier).toContain("external edge logs could not be read");
    expect(verifier).toContain("callback_urls+=(");
  });

  it("keeps public and TLS checks mandatory in release and monitoring", () => {
    expect(release).toContain('MONITOR_EDGE_MODE" == "$edge_mode"');
    expect(release).toContain("67-external-edge-contract.log");
    expect(release).toContain("deploy/edge/docker-compose.external.yml");
    expect(rollback).toContain("deploy/edge/docker-compose.external.yml");
    expect(monitor).toContain("MONITOR_EXPECT_EDGE\" == true");
    expect(monitor).toContain("verify-external-edge.sh");
    expect(monitor).toContain("--scope full");
    expect(reconciler).toContain('if [[ "$edge_mode" == external ]]');
  });

  it("makes development external-edge and public acceptance explicit", () => {
    expect(developmentInstaller).toContain("--external-edge");
    expect(developmentInstaller).toContain('edge_mode="compose"');
    expect(developmentInstaller).toContain("--require-public-acceptance");
    expect(developmentInstaller).toContain("provider gates were unchanged");
    expect(developmentInstaller).toContain("--internal");
    expect(developmentInstaller).toContain("com.business-finlynq.edge-owner=external");
    expect(developmentDeployer).toContain("deploy/edge/docker-compose.external.yml");
    expect(developmentDeployer).toContain("verify-external-edge.sh --scope development");
    expect(developmentDeployer).toContain("same-revision development public acceptance failed twice");
  });
});
