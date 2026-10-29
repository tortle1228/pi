#!/usr/bin/env node

// Builds the native grep engine for this machine and installs it where the grep tool looks for it:
// native/prebuilds/<platform>-<arch>/pi_grep.node. Without it, the grep tool uses ripgrep.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const crateDirectory = join(packageDirectory, "native", "grep");

const build = spawnSync("cargo", ["build", "--release", "--locked"], { cwd: crateDirectory, stdio: "inherit" });
if (build.error) throw new Error(`Could not run cargo: ${build.error.message}. Install Rust from https://rustup.rs`);
if (build.status !== 0) process.exit(build.status ?? 1);

// cargo names a cdylib after the platform's shared-library convention; Node loads it from a .node file.
const libraryName =
	process.platform === "win32" ? "pi_grep.dll" : process.platform === "darwin" ? "libpi_grep.dylib" : "libpi_grep.so";
const outputDirectory = join(packageDirectory, "native", "prebuilds", `${process.platform}-${process.arch}`);
mkdirSync(outputDirectory, { recursive: true });
const output = join(outputDirectory, "pi_grep.node");
copyFileSync(join(crateDirectory, "target", "release", libraryName), output);
console.log(`Installed ${output}`);
