import { t as INSTALL_ANCHOR } from "./profile-boot-BNu17Y9U.js";
import { resolveProfileDir } from "@deepseek-ai/dsh-app-boot";
import { join } from "node:path";
import { runPluginCommand } from "@deepseek-ai/dsh-plugin-manager/operations";
//#region lib/types/plugin.js
/** dsh plugin forwards pnpm through the shared profile package operations. */
/** Run package management for a profile.
* @param profile Profile name.
* @param args Pnpm arguments relative to the invoking directory.
* @returns Pnpm exit code.
*/
async function runPlugin(profile, args) {
	const result = await runPluginCommand({
		profile,
		installAnchor: INSTALL_ANCHOR,
		cwd: process.cwd()
	}, args, {
		execution: "cli",
		outputBytes: 16384,
		lockWaitMs: 12e4,
		onOutput: (text, stream) => {
			process[stream].write(text);
		}
	});
	if (result.exitCode === 127) process.stderr.write("dsh: pnpm was not found; install pnpm and make it available on PATH.\n");
	if (result.exitCode !== 0) process.stderr.write(`dsh: pnpm failed; diagnostics: ${result.logPath}\n`);
	if (result.exitCode !== 0 && args.some((argument) => /^git\+|^github:|\.git(?:#|$)/.test(argument))) process.stderr.write(`dsh: git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed — add the exact key pnpm printed above under allowBuilds in ${join(resolveProfileDir(profile), "pnpm-workspace.yaml")}, then re-run\n`);
	return result.exitCode;
}
//#endregion
export { runPlugin };
