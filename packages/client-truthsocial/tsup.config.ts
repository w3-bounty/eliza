import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    external: [
        "path",
        "@reflink/reflink",
        "@node-llama-cpp",
        "https",
        "http",
        "agentkeepalive",
        "puppeteer",
        "puppeteer-extra",
        "puppeteer-extra-plugin-stealth",
        "puppeteer-extra-plugin-adblocker"
    ],
});
