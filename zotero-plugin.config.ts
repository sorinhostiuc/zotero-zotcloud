import { defineConfig } from "zotero-plugin-scaffold";
import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import pkg from "./package.json";

export function getRootXpiDestinations(version: string): string[] {
  return ["zotcloud.xpi", `zotcloud-${version}.xpi`];
}

export default defineConfig({
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  source: ["src", "addon"],
  dist: ".scaffold/build",
  build: {
    assets: "addon/**/*.*",
    define: {
      addonName: pkg.config.addonName,
      addonID: pkg.config.addonID,
      addonRef: pkg.config.addonRef,
      addonInstance: pkg.config.addonInstance,
      buildVersion: pkg.version,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        bundle: true,
        target: "firefox115",
        outdir: ".scaffold/build/addon",
      },
    ],
    hooks: {
      "build:pack": async (ctx) => {
        const source = resolve(ctx.dist, `${ctx.xpiName}.xpi`);
        await Promise.all(
          getRootXpiDestinations(ctx.version).map(destination => (
            copyFile(source, resolve(destination))
          )),
        );
      },
    },
  },
});
