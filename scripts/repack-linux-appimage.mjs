import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Libraries that must come from the host rather than the Ubuntu build box:
// Wayland, because host Mesa and WebKitGTK need the matching ABI; PipeWire and
// its SPA modules, because libpipewire loads plugins from a directory baked in
// at build time (Ubuntu's multiarch path does not exist on Fedora), so a bundled
// copy silently fails to capture there. libpulse stays bundled: it only speaks a
// stable socket protocol to the daemon, and it dlopens its own libpulsecommon.
const hostLibraryPatterns = [
  /^libwayland-.*\.so(?:\..*)?$/,
  /^libpipewire-.*\.so(?:\..*)?$/,
  /^libspa-.*\.so(?:\..*)?$/,
];
const gdkBackendDefault = 'export GDK_BACKEND="${GDK_BACKEND:-x11,wayland}"';

// The bundled xdg-utils 1.1.3 predates KDE Plasma 6, where xdg-open does
// nothing, so the shims run the host's copy outside the AppImage environment.
const hostXdgUtils = ["xdg-open", "xdg-mime"];
const bundledXdgSuffix = ".bundled";
const xdgShimMarker = "# anarlog-host-xdg-shim";
const xdgShim = `#!/bin/sh
${xdgShimMarker}
name=\${0##*/}
self_dir=$(cd "\${0%/*}" && pwd -P)
appdir=\${APPDIR:-\${self_dir%/usr/bin}}

without_appdir() {
  kept=
  old_ifs=$IFS
  IFS=:
  for entry in $1; do
    case "$entry" in
      "" | "$appdir" | "$appdir"/*) ;;
      *) kept=\${kept:+$kept:}$entry ;;
    esac
  done
  IFS=$old_ifs
  printf '%s' "$kept"
}

host_path=$(without_appdir "$PATH")
host=
old_ifs=$IFS
IFS=:
for dir in $host_path; do
  if [ "$dir" != "$self_dir" ] && [ -x "$dir/$name" ]; then
    host=$dir/$name
    break
  fi
done
IFS=$old_ifs

if [ -z "$host" ]; then
  exec "$self_dir/$name${bundledXdgSuffix}" "$@"
fi

for list in XDG_DATA_DIRS LD_LIBRARY_PATH; do
  eval "value=\\\${$list:-}"
  cleaned=$(without_appdir "$value")
  if [ -n "$cleaned" ]; then
    export "$list=$cleaned"
  else
    unset "$list"
  fi
done
export PATH="$host_path"
unset APPDIR APPIMAGE ARGV0 OWD GDK_BACKEND GDK_PIXBUF_MODULE_FILE \\
  GIO_EXTRA_MODULES GI_TYPELIB_PATH GSETTINGS_SCHEMA_DIR GTK_DATA_PREFIX \\
  GTK_EXE_PREFIX GTK_IM_MODULE_FILE GTK_PATH GTK_THEME PERLLIB PYTHONHOME \\
  PYTHONPATH QT_PLUGIN_PATH
exec "$host" "$@"
`;

function patchGtkHook(source) {
  if (source.includes(gdkBackendDefault)) {
    return source;
  }

  // Keep X11 preferred, but allow Wayland-only sessions and explicit overrides.
  const forcedX11 = /^export GDK_BACKEND=x11(?:[ \t]+#.*)?$/m;
  if (!forcedX11.test(source)) {
    throw new Error("Unrecognized GDK_BACKEND setting in AppImage GTK hook");
  }
  return source.replace(forcedX11, gdkBackendDefault);
}

async function findUnshimmedXdgUtils(appDirectory) {
  const binDirectory = path.join(appDirectory, "usr", "bin");
  const unshimmed = [];
  for (const name of hostXdgUtils) {
    const tool = path.join(binDirectory, name);
    let source;
    try {
      source = await readFile(tool, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!source.includes(xdgShimMarker)) {
      unshimmed.push(tool);
    }
  }
  return unshimmed;
}

async function shimXdgUtils(tools) {
  for (const tool of tools) {
    await rename(tool, `${tool}${bundledXdgSuffix}`);
    await writeFile(tool, xdgShim);
    await chmod(tool, 0o755);
  }
}

async function findSingleBundleEntry(bundleDirectory, suffix, isExpectedType) {
  const entries = await readdir(bundleDirectory, { withFileTypes: true });
  const matches = entries.filter(
    (entry) => entry.name.endsWith(suffix) && isExpectedType(entry),
  );

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${suffix} in ${bundleDirectory}, found ${matches.length}`,
    );
  }

  return path.join(bundleDirectory, matches[0].name);
}

export async function findBundledHostLibraries(directory) {
  const matches = [];

  async function walk(currentDirectory) {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (
        hostLibraryPatterns.some((pattern) => pattern.test(entry.name))
      ) {
        matches.push(entryPath);
      }
    }
  }

  await walk(directory);
  return matches.sort();
}

function defaultPluginPath() {
  const cacheDirectory =
    process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(
    cacheDirectory,
    "tauri",
    "linuxdeploy-plugin-appimage.AppImage",
  );
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
        ),
      );
    });
  });
}

export async function repackLinuxAppImage({
  bundleDirectory,
  arch = process.env.ARCH,
  pluginPath = process.env.TAURI_APPIMAGE_PLUGIN ?? defaultPluginPath(),
  run = runCommand,
}) {
  const appDirectory = await findSingleBundleEntry(
    bundleDirectory,
    ".AppDir",
    (entry) => entry.isDirectory(),
  );
  const appImage = await findSingleBundleEntry(
    bundleDirectory,
    ".AppImage",
    (entry) => entry.isFile(),
  );
  const hostLibraries = await findBundledHostLibraries(
    path.join(appDirectory, "usr"),
  );
  const gtkHook = path.join(
    appDirectory,
    "apprun-hooks",
    "linuxdeploy-plugin-gtk.sh",
  );
  const originalGtkHook = await readFile(gtkHook, "utf8");
  const patchedGtkHook = patchGtkHook(originalGtkHook);
  const updatedGtkHook = originalGtkHook !== patchedGtkHook;
  const xdgUtils = await findUnshimmedXdgUtils(appDirectory);

  if (hostLibraries.length === 0 && !updatedGtkHook && xdgUtils.length === 0) {
    console.log(
      `AppImage already uses host Wayland and PipeWire libraries, GTK backends, and xdg-utils: ${appImage}`,
    );
    return {
      appDirectory,
      appImage,
      removedLibraries: [],
      updatedGtkHook,
      shimmedXdgUtils: [],
    };
  }

  if (!arch) {
    throw new Error("AppImage architecture is required for repacking");
  }

  try {
    await access(pluginPath, constants.X_OK);
  } catch {
    throw new Error(`AppImage output plugin is not executable: ${pluginPath}`);
  }

  if (updatedGtkHook) {
    await writeFile(gtkHook, patchedGtkHook);
  }
  await shimXdgUtils(xdgUtils);
  await Promise.all(hostLibraries.map((library) => rm(library)));

  const remainingLibraries = await findBundledHostLibraries(
    path.join(appDirectory, "usr"),
  );
  if (remainingLibraries.length > 0) {
    throw new Error(
      `Failed to remove bundled host libraries: ${remainingLibraries.join(", ")}`,
    );
  }

  console.log(`Removed bundled host libraries:\n${hostLibraries.join("\n")}`);

  await rm(appImage);
  await run(
    pluginPath,
    ["--appimage-extract-and-run", "--appdir", appDirectory],
    {
      env: {
        ...process.env,
        APPIMAGE_EXTRACT_AND_RUN: "1",
        ARCH: arch,
        OUTPUT: appImage,
      },
    },
  );

  const appImageStat = await stat(appImage);
  if (appImageStat.size === 0) {
    throw new Error(`Repacked AppImage is empty: ${appImage}`);
  }

  const signature = `${appImage}.sig`;
  await rm(signature, { force: true });
  await run("pnpm", ["-F", "desktop", "tauri", "signer", "sign", appImage]);

  const signatureStat = await stat(signature);
  if (signatureStat.size === 0) {
    throw new Error(`Regenerated AppImage signature is empty: ${signature}`);
  }

  console.log(`Repacked and re-signed AppImage: ${appImage}`);
  return {
    appDirectory,
    appImage,
    removedLibraries: hostLibraries,
    updatedGtkHook,
    shimmedXdgUtils: xdgUtils,
  };
}

async function main() {
  const bundleDirectory = process.argv[2];
  if (!bundleDirectory) {
    throw new Error(
      "Usage: node scripts/repack-linux-appimage.mjs <appimage-bundle-directory>",
    );
  }

  await repackLinuxAppImage({
    bundleDirectory: path.resolve(bundleDirectory),
  });
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
