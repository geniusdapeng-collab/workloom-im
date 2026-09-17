import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(packageDir, "dist");

await mkdir(distDir, { recursive: true });
for (const filename of ["content-safety.css", "tokens.css", "components.css"]) {
  await copyFile(join(packageDir, "src", filename), join(distDir, filename));
}

// TypeScript may preserve empty directories on some versions. Keeping the build
// surface deterministic makes package-content checks and release signatures stable.
await rm(join(distDir, "__tests__"), { recursive: true, force: true });
