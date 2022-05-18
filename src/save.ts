import * as cache from "@actions/cache";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as glob from "@actions/glob";
import * as io from "@actions/io";
import fs from "fs";
import path from "path";
import {
  cleanTarget,
  getCacheConfig,
  // getCargoBins,
  getPackages,
  Packages,
  paths,
  rm,
  getLockfileHash,
  // stateBins,
  // stateKey,
} from "./common";

const { readdirSync } = require('fs')


async function run() {
  if (!cache.isFeatureAvailable()) {
    return;
  }
  const enable_multi_crate = core.getInput("enable-multi-crate") || false;
  core.info(`enable-multi-crate": ${enable_multi_crate}`);
  
  var dirs = new Array();
  const wdir = process.cwd();

  const getDirectories = (source: any) =>
    readdirSync(source, { withFileTypes: true })
      .filter((dirent: { isDirectory: () => any; }) => dirent.isDirectory())
      .map((dirent: { name: any; }) => dirent.name)



  if (enable_multi_crate){
    const subdirs = getDirectories(wdir);
    for (const subdir of subdirs){
      dirs.push(wdir + "/" + subdir);
    }
  }
  else{
    dirs.push(wdir)

  }
  core.info(`dirs: ${JSON.stringify(dirs)}`)
  for (const dir of dirs){
    process.chdir(dir);
    core.info(`***** - subdir: ${dir}`)


    try {
      const { paths: savePaths, key } = await getCacheConfig();

      let uniqueKey = await getLockfileHash();
      if (core.getState(uniqueKey) === uniqueKey) {
        core.info(`Key: ${key}: Cache up-to-date.`);
        continue;
      }

      // TODO: remove this once https://github.com/actions/toolkit/pull/553 lands
      await macOsWorkaround();

      const registryName = await getRegistryName();
      const packages = await getPackages();

      try {
        await cleanRegistry(registryName, packages);
      } catch {}

      core.info(`Removed  cleanBin as it prevents us working with multiple cargo directories`);
      // try {
      //   await cleanBin();
      // } catch {}

      try {
        await cleanGit(packages);
      } catch {}

      try {
        await cleanTarget(packages);
      } catch {}

      core.info(`Saving paths:\n    ${savePaths.join("\n    ")}`);
      core.info(`In directory:\n    ${process.cwd()}`);
      core.info(`Using key:\n    ${key}`);
      await cache.saveCache(savePaths, key);
    } catch (e) {
      core.info(`[warning] ${(e as any).message}`);
    }
  }
}

run();

async function getRegistryName(): Promise<string> {
  const globber = await glob.create(`${paths.index}/**/.last-updated`, { followSymbolicLinks: false });
  const files = await globber.glob();
  if (files.length > 1) {
    core.warning(`got multiple registries: "${files.join('", "')}"`);
  }

  const first = files.shift()!;
  return path.basename(path.dirname(first));
}

// async function cleanBin() {
//   const bins = await getCargoBins();
//   const oldBins = JSON.parse(core.getState(stateBins));

//   for (const bin of oldBins) {
//     bins.delete(bin);
//   }

//   const dir = await fs.promises.opendir(path.join(paths.cargoHome, "bin"));
//   for await (const dirent of dir) {
//     if (dirent.isFile() && !bins.has(dirent.name)) {
//       await rm(dir.path, dirent);
//     }
//   }
// }

async function cleanRegistry(registryName: string, packages: Packages) {
  await io.rmRF(path.join(paths.index, registryName, ".cache"));

  const pkgSet = new Set(packages.map((p) => `${p.name}-${p.version}.crate`));

  const dir = await fs.promises.opendir(path.join(paths.cache, registryName));
  for await (const dirent of dir) {
    if (dirent.isFile() && !pkgSet.has(dirent.name)) {
      await rm(dir.path, dirent);
    }
  }
}

async function cleanGit(packages: Packages) {
  const coPath = path.join(paths.git, "checkouts");
  const dbPath = path.join(paths.git, "db");
  const repos = new Map<string, Set<string>>();
  for (const p of packages) {
    if (!p.path.startsWith(coPath)) {
      continue;
    }
    const [repo, ref] = p.path.slice(coPath.length + 1).split(path.sep);
    const refs = repos.get(repo);
    if (refs) {
      refs.add(ref);
    } else {
      repos.set(repo, new Set([ref]));
    }
  }

  // we have to keep both the clone, and the checkout, removing either will
  // trigger a rebuild

  let dir: fs.Dir;
  // clean the db
  dir = await fs.promises.opendir(dbPath);
  for await (const dirent of dir) {
    if (!repos.has(dirent.name)) {
      await rm(dir.path, dirent);
    }
  }

  // clean the checkouts
  dir = await fs.promises.opendir(coPath);
  for await (const dirent of dir) {
    const refs = repos.get(dirent.name);
    if (!refs) {
      await rm(dir.path, dirent);
      continue;
    }
    if (!dirent.isDirectory()) {
      continue;
    }
    const refsDir = await fs.promises.opendir(path.join(dir.path, dirent.name));
    for await (const dirent of refsDir) {
      if (!refs.has(dirent.name)) {
        await rm(refsDir.path, dirent);
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

