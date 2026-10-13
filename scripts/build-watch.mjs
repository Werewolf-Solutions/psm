import {build} from "esbuild";
await build({entryPoints:["src/watch/main.ts"],bundle:true,platform:"node",format:"esm",target:"node22",outfile:process.env.WATCH_OUTPUT ?? "dist/watch.mjs"});
