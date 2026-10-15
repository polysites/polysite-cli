#!/usr/bin/env node
import { main } from "../src/cli.js";

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  process.stderr.write(`polysite needs Node.js 22 or newer (this is ${process.versions.node}).\n`);
  process.exit(1);
}

process.exitCode = await main(process.argv.slice(2));
