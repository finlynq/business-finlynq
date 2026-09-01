import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const digestPattern = "sha256:[a-f0-9]{64}";

describe("external container supply-chain pins", () => {
  it("pins every Dockerfile base to a readable tag and immutable digest", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    const externalBases = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)]
      .map((match) => match[1])
      .filter((image) => image !== "dependencies");

    expect(externalBases.length).toBeGreaterThan(0);
    for (const image of externalBases) {
      expect(image).toMatch(new RegExp(`^[^@\\s]+@${digestPattern}$`));
    }
  });

  it("pins the PostgreSQL base and production Caddy service while using the immutable database target", () => {
    const compose = readFileSync("docker-compose.yml", "utf8").replaceAll("\r\n", "\n");
    const dockerfile = readFileSync("Dockerfile", "utf8");

    expect(compose).not.toMatch(/^\s*image:\s+(?:postgres|caddy):[^@\s]+\s*$/gm);
    expect(compose).toContain("image: business-finlynq-database:${BUSINESS_FINLYNQ_IMAGE_REVISION:?set BUSINESS_FINLYNQ_IMAGE_REVISION}");
    expect(compose).toContain("target: database");
    expect(compose).not.toContain("./deploy/postgres/010-runtime-role.sh:/docker-entrypoint-initdb.d/");
    expect(dockerfile).toMatch(new RegExp(`FROM postgres:16-alpine@${digestPattern} AS database`));
    expect(dockerfile).toContain("COPY --chmod=0555 deploy/postgres/010-runtime-role.sh /docker-entrypoint-initdb.d/010-runtime-role.sh");
    expect(dockerfile).toContain("COPY --chmod=0555 deploy/postgres/database-entrypoint.sh /usr/local/bin/business-finlynq-database-entrypoint");
    expect(dockerfile).toContain('ENTRYPOINT ["business-finlynq-database-entrypoint"]');
    expect(compose).toContain("/run/business-finlynq-init:size=64k,mode=0700,uid=70,gid=70,noexec,nosuid,nodev");
    expect(compose).toMatch(new RegExp(`image: caddy:2\\.10\\.2-alpine@${digestPattern}`));
  });

  it("hands the database initializer its password only through a PostgreSQL-owned tmpfs file", () => {
    const compose = readFileSync("docker-compose.yml", "utf8").replaceAll("\r\n", "\n");
    const entrypoint = readFileSync("deploy/postgres/database-entrypoint.sh", "utf8");
    const databaseStart = compose.indexOf("  database:\n");
    const databaseEnd = compose.indexOf("\n  provision_auth_worker_role:\n", databaseStart);
    const database = compose.slice(databaseStart, databaseEnd);

    expect(database).toContain("APP_DATABASE_PASSWORD_FILE: /run/secrets/business_finlynq_app_db_password");
    expect(database).toContain("/run/business-finlynq-init:size=64k,mode=0700,uid=70,gid=70,noexec,nosuid,nodev");
    expect(database).not.toContain("group_add:");
    expect(entrypoint).toContain("[ \"$(id -u)\" = 0 ]");
    expect(entrypoint).toContain("/run/secrets/business_finlynq_app_db_password");
    expect(entrypoint).toContain("/run/business-finlynq-init");
    expect(entrypoint).toContain("70:70:700");
    expect(entrypoint).toContain('if [ -s "$pgdata_directory/PG_VERSION" ]');
    expect(entrypoint).toContain("chown 70:70");
    expect(entrypoint).toContain("chmod 0400");
    expect(entrypoint).toContain('export APP_DATABASE_PASSWORD_FILE="$runtime_file"');
    expect(entrypoint).toContain('exec /usr/local/bin/docker-entrypoint.sh "$@"');
    expect(entrypoint).not.toContain("cat ");
    const initializer = readFileSync("deploy/postgres/010-runtime-role.sh", "utf8");
    expect(initializer).toContain("/run/business-finlynq-init/app-db-password");
    expect(initializer).toContain('rm -f -- "$APP_DATABASE_PASSWORD_FILE"');
  });
});
