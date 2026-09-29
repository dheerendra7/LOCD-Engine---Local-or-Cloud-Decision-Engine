import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const { stdout } = await exec("git", ["ls-files"]);
const files = stdout
  .split("\n")
  .filter(Boolean)
  .filter(file => /\.(mjs|js)$/.test(file));

let errors = 0;

for (const file of files) {
  try {
    await exec(process.execPath, ["--check", file]);
  } catch (error) {
    console.error(file);
    console.error(error.stderr || error.message);
    errors++;
  }
}

if (errors) process.exit(1);
console.log("Syntax lint passed.");
