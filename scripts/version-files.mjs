import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const VERSION_FILES = (root) => ({
  rootPkg: resolve(root, 'package.json'),
  desktopPkg: resolve(root, 'apps/desktop/package.json'),
  tauriConf: resolve(root, 'apps/desktop/src-tauri/tauri.conf.json'),
  cargoToml: resolve(root, 'apps/desktop/src-tauri/Cargo.toml'),
});

export function readVersions(root) {
  const paths = VERSION_FILES(root);
  const rootVer = JSON.parse(readFileSync(paths.rootPkg, 'utf8')).version;
  const desktopVer = JSON.parse(readFileSync(paths.desktopPkg, 'utf8')).version;
  const tauriVer = JSON.parse(readFileSync(paths.tauriConf, 'utf8')).version;
  const cargoText = readFileSync(paths.cargoToml, 'utf8');
  const cargoMatch = cargoText.match(/^version = "([^"]+)"/m);
  const cargoVer = cargoMatch?.[1] ?? null;
  return { rootVer, desktopVer, tauriVer, cargoVer };
}

export function versionsMatch(root) {
  const v = readVersions(root);
  const vals = [v.rootVer, v.desktopVer, v.tauriVer, v.cargoVer];
  if (vals.some((x) => !x)) return false;
  return new Set(vals).size === 1;
}

export function canonicalVersion(root) {
  const v = readVersions(root);
  return v.rootVer;
}

/** @param {string} tag e.g. v0.1.0 */
export function tagMatchesVersion(tag, version) {
  const normalized = tag.startsWith('v') ? tag : `v${tag}`;
  return normalized === `v${version}`;
}

export function setVersion(root, version) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid semver: ${version}`);
  }
  const paths = VERSION_FILES(root);

  for (const pkgPath of [paths.rootPkg, paths.desktopPkg]) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    pkg.version = version;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  const tauriText = readFileSync(paths.tauriConf, 'utf8');
  if (!/"version":\s*"[^"]+"/.test(tauriText)) {
    throw new Error('tauri.conf.json version field not found');
  }
  writeFileSync(
    paths.tauriConf,
    tauriText.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`),
  );

  const cargoText = readFileSync(paths.cargoToml, 'utf8');
  if (!/^version = "[^"]+"/m.test(cargoText)) {
    throw new Error('Cargo.toml [package] version not found');
  }
  writeFileSync(
    paths.cargoToml,
    cargoText.replace(/^version = "[^"]+"/m, `version = "${version}"`),
  );
}
