import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const jsonFiles = ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json'];
const packages = jsonFiles.map((file) => JSON.parse(readFileSync(file, 'utf8')));
const cargoFile = 'src-tauri/Cargo.toml';
const cargo = readFileSync(cargoFile, 'utf8');
const cargoVersion = cargo.match(/\[package\][\s\S]*?^version = "([^"]+)"/m)?.[1];
const cargoLockVersion = readFileSync('src-tauri/Cargo.lock', 'utf8')
  .match(/\[\[package\]\]\s+name = "abw"\s+version = "([^"]+)"/)?.[1];
const current = packages[0].version;
if (process.argv[2] === '--check') {
  if (packages.some((data) => data.version !== current) ||
      packages[1].packages[''].version !== current || cargoVersion !== current || cargoLockVersion !== current) {
    throw new Error('Release versions are out of sync. Run npm run release:prepare -- patch.');
  }
  const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : null;
  if (tag && tag !== `v${current}`) throw new Error(`Tag ${tag} does not match version ${current}.`);
  console.log(`Release version ${current} is consistent.`);
} else {
  const bump = process.argv[2] || 'patch';
  if (!['major', 'minor', 'patch'].includes(bump)) throw new Error('Use major, minor or patch.');
  if (!/^\d+\.\d+\.\d+$/.test(current)) throw new Error('Expected a stable semantic version.');
  const values = current.split('.').map(Number);
  const index = ['major', 'minor', 'patch'].indexOf(bump);
  values[index] += 1;
  for (let position = index + 1; position < 3; position += 1) values[position] = 0;
  const next = values.join('.');
  if (!cargoVersion) throw new Error('Cargo package version is missing.');
  for (const [index, file] of jsonFiles.entries()) {
    packages[index].version = next;
    if (file === 'package-lock.json') packages[index].packages[''].version = next;
    writeFileSync(file, `${JSON.stringify(packages[index], null, 2)}\n`);
  }
  writeFileSync(cargoFile, cargo.replace(/(\[package\][\s\S]*?^version = ")[^"]+("\s*$)/m, `$1${next}$2`));
  execFileSync('cargo', ['update', '--manifest-path', cargoFile, '--package', 'abw', '--offline'], { stdio: 'inherit' });
  console.log(`Prepared v${next}. Commit the changes, then tag that commit v${next} to publish a tested installer.`);
}
