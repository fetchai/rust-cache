import * as cache from "@actions/cache";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as io from "@actions/io";
import fs from "fs";
import path from "path";
import { getCaches, getCmdOutput, getRegistryName, isValidEvent, paths } from "./common";

async function run() {
  if (!isValidEvent()) {
    return;
  }

  try {
    const caches = await getCaches();
    let upToDate = true;
    for (const [type, { key }] of Object.entries(caches)) {
      if (core.getState(`CACHEKEY-${type}`) !== key) {
        upToDate = false;
        break;
      }
    }
    if (upToDate) {
      core.info(`All caches up-to-date`);
      return;
    }

    const registryName = await getRegistryName();
    const packages = await getPackages();

    // TODO: remove this once https://github.com/actions/toolkit/pull/553 lands
    await macOsWorkaround();

    await io.rmRF(path.join(paths.index, registryName, ".cache"));
    await pruneRegistryCache(registryName, packages);

    await pruneTarget(packages);

    for (const [type, { name, path: paths, key }] of Object.entries(caches)) {
      if (core.getState(`CACHEKEY-${type}`) === key) {
        core.info(`${name} up-to-date.`);
        continue;
      }
      const start = Date.now();
      core.startGroup(`Saving ${name}…`);
      core.info(`Saving paths:\n    ${paths.join("\n    ")}.`);
      core.info(`Using key "${key}".`);
      try {
        await cache.saveCache(paths, key);
      } catch (e) {
        core.info(`[warning] ${e.message}`);
      }
      const duration = Math.round((Date.now() - start) / 1000);
      if (duration) {
        core.info(`Took ${duration}s.`);
      }
      core.endGroup();
    }
  } catch (e) {
    core.info(`[warning] ${e.message}`);
  }
}

run();

interface PackageDefinition {
  name: string;
  version: string;
  targets: Array<string>;
}

type Packages = Array<PackageDefinition>;

interface Meta {
  packages: Array<{
    name: string;
    version: string;
    manifest_path: string;
    targets: Array<{ kind: Array<string>; name: string }>;
  }>;
}

async function getPackages(): Promise<Packages> {
  const cwd = process.cwd();
  const meta: Meta = JSON.parse(await getCmdOutput("cargo", ["metadata", "--all-features", "--format-version", "1"]));

  return meta.packages
    .filter((p) => !p.manifest_path.startsWith(cwd))
    .map((p) => {
      const targets = p.targets.filter((t) => t.kind[0] === "lib").map((t) => t.name);
      return { name: p.name, version: p.version, targets };
    });
}

async function pruneRegistryCache(registryName: string, packages: Packages) {
  const pkgSet = new Set(packages.map((p) => `${p.name}-${p.version}.crate`));

  const dir = await fs.promises.opendir(path.join(paths.cache, registryName));
  for await (const dirent of dir) {
    if (dirent.isFile() && !pkgSet.has(dirent.name)) {
      const fileName = path.join(dir.path, dirent.name);
      await fs.promises.unlink(fileName);
      core.debug(`deleting "${fileName}"`);
    }
  }
}

async function pruneTarget(packages: Packages) {
  await fs.promises.unlink("./target/.rustc_info.json");
  await io.rmRF("./target/debug/examples");
  await io.rmRF("./target/debug/incremental");
  let dir: fs.Dir;

  // remove all *files* from debug
  dir = await fs.promises.opendir("./target/debug");
  for await (const dirent of dir) {
    if (dirent.isFile()) {
      const fileName = path.join(dir.path, dirent.name);
      await fs.promises.unlink(fileName);
    }
  }

  const keepPkg = new Set(packages.map((p) => p.name));
  await rmExcept("./target/debug/build", keepPkg);
  await rmExcept("./target/debug/.fingerprint", keepPkg);

  const keepDeps = new Set(
    packages.flatMap((p) => {
      const names = [];
      for (const n of [p.name, ...p.targets]) {
        const name = n.replace(/-/g, "_");
        names.push(name, `lib${name}`);
      }
      return names;
    }),
  );
  await rmExcept("./target/debug/deps", keepDeps);
}

const twoWeeks = 14 * 24 * 3600 * 1000;

async function rmExcept(dirName: string, keepPrefix: Set<string>) {
  const dir = await fs.promises.opendir(dirName);
  for await (const dirent of dir) {
    let name = dirent.name;
    const idx = name.lastIndexOf("-");
    if (idx !== -1) {
      name = name.slice(0, idx);
    }
    const fileName = path.join(dir.path, dirent.name);
    const { mtime } = await fs.promises.stat(fileName);
    if (!keepPrefix.has(name) || Date.now() - mtime.getTime() > twoWeeks) {
      core.debug(`deleting "${fileName}"`);
      if (dirent.isFile()) {
        await fs.promises.unlink(fileName);
      } else if (dirent.isDirectory()) {
        await io.rmRF(fileName);
      }
    }
  }
}

async function macOsWorkaround() {
  try {
    // Workaround for https://github.com/actions/cache/issues/403
    // Also see https://github.com/rust-lang/cargo/issues/8603
    await exec.exec("sudo", ["/usr/sbin/purge"], { silent: true });
  } catch {}
}
