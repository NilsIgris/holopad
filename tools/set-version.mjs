#!/usr/bin/env node
// Prépare une version : numéro, dépôt pour les mises à jour, clé publique du updater.
//   node tools/set-version.mjs 1.2.3
// Variables lues : HOLOPAD_REPO (propriétaire/nom), TAURI_UPDATER_PUBKEY.

import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("Usage : node tools/set-version.mjs X.Y.Z");
  process.exit(1);
}

const json = (path, edit) => {
  const data = JSON.parse(readFileSync(path, "utf8"));
  edit(data);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
};

json("package.json", (p) => (p.version = version));

json("src-tauri/tauri.conf.json", (c) => {
  c.version = version;
  const repo = process.env.HOLOPAD_REPO;
  const pubkey = process.env.TAURI_UPDATER_PUBKEY;
  if (repo) c.plugins.updater.endpoints = [`https://github.com/${repo}/releases/latest/download/latest.json`];
  if (pubkey) c.plugins.updater.pubkey = pubkey.trim();
});

const cargoPath = "src-tauri/Cargo.toml";
const cargo = readFileSync(cargoPath, "utf8").replace(/^version = ".*"$/m, `version = "${version}"`);
writeFileSync(cargoPath, cargo);

console.log(`Version ${version} appliquée`);
