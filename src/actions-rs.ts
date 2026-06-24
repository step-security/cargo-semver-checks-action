import { promises as fs } from "fs";
import * as path from "path";
import * as process from "process";

import * as io from "@actions/io";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as tc from "@actions/tool-cache";

// input helpers (from actions-rs/core/src/input.ts)
function getInput(name: string, options?: core.InputOptions): string {
    const inputFullName = name.replace(/-/g, "_");
    const value = core.getInput(inputFullName, options);
    if (value.length > 0) {
        return value;
    }
    return core.getInput(name, options);
}

function getInputBool(name: string, options?: core.InputOptions): boolean {
    const value = getInput(name, options);
    return value === "true" || value === "1";
}

function getInputList(name: string, options?: core.InputOptions): string[] {
    return getInput(name, options)
        .split(",")
        .map((item: string) => item.trim())
        .filter((item: string) => item.length > 0);
}

export const input = { getInput, getInputBool, getInputList };

// Cargo (from actions-rs/core/src/commands/cargo.ts)
export class Cargo {
    private readonly path: string;

    private constructor(p: string) {
        this.path = p;
    }

    public static async get(): Promise<Cargo> {
        try {
            const p = await io.which("cargo", true);
            return new Cargo(p);
        } catch (error) {
            core.error(
                "cargo is not installed. Use the step-security/actions-rs-toolchain action to install it.",
            );
            throw error;
        }
    }

    public async call(args: string[], options?: exec.ExecOptions): Promise<number> {
        return await exec.exec(this.path, args, options);
    }
}

// RustUp (from actions-rs/core/src/commands/rustup.ts)
export interface ToolchainOptions {
    default?: boolean;
    override?: boolean;
    components?: string[];
    noSelfUpdate?: boolean;
    allowDowngrade?: boolean;
    force?: boolean;
}

type Profile = "minimal" | "default" | "full";

export class RustUp {
    private readonly path: string;

    private constructor(exePath: string) {
        this.path = exePath;
    }

    public static async getOrInstall(): Promise<RustUp> {
        try {
            return await RustUp.get();
        } catch (error) {
            core.debug(`Unable to find "rustup" executable, installing it now. Reason: ${error}`);
            return await RustUp.install();
        }
    }

    public static async get(): Promise<RustUp> {
        const exePath = await io.which("rustup", true);
        return new RustUp(exePath);
    }

    public static async install(): Promise<RustUp> {
        const args = ["--default-toolchain", "none", "-y"];

        switch (process.platform) {
            case "darwin":
            case "linux": {
                const rustupSh = await tc.downloadTool("https://sh.rustup.rs");
                await fs.chmod(rustupSh, 0o755);
                await exec.exec(rustupSh, args);
                break;
            }
            case "win32": {
                const rustupExe = await tc.downloadTool("https://win.rustup.rs");
                await exec.exec(rustupExe, args);
                break;
            }
            default:
                throw new Error(`Unknown platform ${process.platform}, can't install rustup`);
        }

        core.addPath(path.join(process.env.HOME!, ".cargo", "bin"));
        return new RustUp("rustup");
    }

    public async installToolchain(name: string, options?: ToolchainOptions): Promise<number> {
        const args = ["toolchain", "install", name];

        if (options) {
            if (options.components && options.components.length > 0) {
                for (const component of options.components) {
                    args.push("--component");
                    args.push(component);
                }
            }
            if (options.noSelfUpdate) {
                args.push("--no-self-update");
            }
            if (options.allowDowngrade) {
                args.push("--allow-downgrade");
            }
            if (options.force) {
                args.push("--force");
            }
        }

        await this.call(args);

        if (options && options.default) {
            await this.call(["default", name]);
        }
        if (options && options.override) {
            await this.call(["override", "set", name]);
        }

        return 0;
    }

    public async setProfile(name: Profile): Promise<number> {
        return await this.call(["set", "profile", name]);
    }

    public async call(args: string[], options?: exec.ExecOptions): Promise<number> {
        return await exec.exec(this.path, args, options);
    }
}
