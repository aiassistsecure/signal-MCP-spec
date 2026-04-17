import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm", "cjs"],
  dts: { entry: { index: "src/index.ts" } },
  splitting: false,
  sourcemap: true,
  clean: true,
  target: "node18",
  platform: "node",
  shims: false,
  outExtension({ format }) {
    return { js: format === "esm" ? ".js" : ".cjs" };
  },
});
