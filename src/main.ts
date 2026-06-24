import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import * as core from "@actions/core";
import * as github from "@actions/github";
import axios, { isAxiosError } from "axios";
import * as io from "@actions/io";
import * as toolCache from "@actions/tool-cache";
import * as rustCore from "./actions-rs";

import {
    getErrorMessage,
    getPlatformMatchingTarget,
    getRustcVersion,
    optionFromList,
    optionIfValueProvided,
} from "./utils";
import { RustdocCache } from "./rustdoc-cache";

async function validateSubscription(): Promise<void> {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    let repoPrivate: boolean | undefined;

    if (eventPath && fs.existsSync(eventPath)) {
        const eventData = JSON.parse(fs.readFileSync(eventPath, "utf8"));
        repoPrivate = eventData?.repository?.private;
    }

    const upstream = "n0-computer/cargo-semver-checks-action";
    const action = process.env.GITHUB_ACTION_REPOSITORY;
    const docsUrl = "https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions";

    core.info("");
    core.info("\u001b[1;36mStepSecurity Maintained Action\u001b[0m");
    core.info(`Secure drop-in replacement for ${upstream}`);
    if (repoPrivate === false) {
        core.info("\u001b[32m\u2713 Free for public repositories\u001b[0m");
    }
    core.info(`\u001b[36mLearn more:\u001b[0m ${docsUrl}`);
    core.info("");

    if (repoPrivate === false) {
        return;
    }

    const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
    const body: Record<string, string> = { action: action || "" };
    if (serverUrl !== "https://github.com") {
        body.ghes_server = serverUrl;
    }
    try {
        await axios.post(
            `https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
            body,
            { timeout: 3000 },
        );
    } catch (error) {
        if (isAxiosError(error) && error.response?.status === 403) {
            core.error(
                `\u001b[1;31mThis action requires a StepSecurity subscription for private repositories.\u001b[0m`,
            );
            core.error(`\u001b[31mLearn how to enable a subscription: ${docsUrl}\u001b[0m`);
            process.exit(1);
        }
        core.info("Timeout or API not reachable. Continuing to next step.");
    }
}

const CARGO_TARGET_DIR = path.join("semver-checks", "target");

function getCheckReleaseArguments(): string[] {
    return [
        optionFromList("--package", rustCore.input.getInputList("package")),
        optionFromList("--exclude", rustCore.input.getInputList("exclude")),
        optionIfValueProvided("--manifest-path", rustCore.input.getInput("manifest-path")),
        optionIfValueProvided("--release-type", rustCore.input.getInput("release-type")),
        getFeatureGroup(rustCore.input.getInput("feature-group")),
        optionFromList("--features", rustCore.input.getInputList("features")),
        rustCore.input.getInputBool("verbose") ? ["--verbose"] : [],
        optionIfValueProvided("--baseline-version", rustCore.input.getInput("baseline-version")),
        optionIfValueProvided("--baseline-rev", rustCore.input.getInput("baseline-rev")),
    ].flat();
}

function getFeatureGroup(name = ""): string[] {
    switch (name) {
        case "all-features":
            return ["--all-features"];
        case "default-features":
            return ["--default-features"];
        case "only-explicit-features":
            return ["--only-explicit-features"];
        case "":
            return [];
        default:
            throw new Error(`Unsupported feature group: ${name}`);
    }
}

function getGitHubToken(): string {
    const token = process.env["GITHUB_TOKEN"] || rustCore.input.getInput("github-token");
    if (!token) {
        throw new Error("Querying the GitHub API is possible only if the GitHub token is set.");
    }
    return token;
}

async function getCargoSemverChecksAsset(target: string): Promise<{ url: string; digest: string }> {
    const octokit = github.getOctokit(getGitHubToken());

    const release = await octokit.rest.repos.getLatestRelease({
        owner: "obi1kenobi",
        repo: "cargo-semver-checks",
    });

    const asset = release.data.assets.find((asset) => {
        return asset["name"].endsWith(`${target}.tar.gz`);
    });

    if (!asset) {
        throw new Error(`Couldn't find a release for target ${target}.`);
    }

    const digest = (asset as unknown as { digest?: string }).digest ?? "";

    return { url: asset.url, digest };
}

async function installRustUpIfRequested(): Promise<void> {
    const toolchain = rustCore.input.getInput("rust-toolchain") || "stable";
    if (toolchain != "manual") {
        const rustup = await rustCore.RustUp.getOrInstall();
        await rustup.call(["show"]);
        await rustup.setProfile("minimal");
        await rustup.installToolchain(toolchain);

        // Setting the environment variable here affects only processes spawned
        // by this action, so it will not override the default toolchain globally.
        process.env["RUSTUP_TOOLCHAIN"] = toolchain;
    }

    // Disable incremental compilation.
    process.env["CARGO_INCREMENTAL"] ||= "0";

    // Enable colors in the output.
    process.env["CARGO_TERM_COLOR"] ||= "always";

    // Enable sparse checkout for crates.io except for Rust 1.66 and 1.67,
    // on which it is unstable.
    if (!process.env["CARGO_REGISTRIES_CRATES_IO_PROTOCOL"]) {
        const rustcVersion = await getRustcVersion();
        if (!rustcVersion.startsWith("rustc-1.66") && !rustcVersion.startsWith("rustc-1.67")) {
            process.env["CARGO_REGISTRIES_CRATES_IO_PROTOCOL"] = "sparse";
        }
    }
}

async function runCargoSemverChecks(cargo: rustCore.Cargo): Promise<void> {
    // The default location of the target directory varies depending on whether
    // the action is run inside a workspace or on a single crate. We therefore
    // need to set the target directory explicitly.
    process.env["CARGO_TARGET_DIR"] = CARGO_TARGET_DIR;

    console.log(["Running cargo semver-checks check-release "].concat(getCheckReleaseArguments()));
    await cargo.call(["semver-checks", "check-release"].concat(getCheckReleaseArguments()));
}

async function installCargoSemverChecksFromPrecompiledBinary(): Promise<void> {
    const { url, digest } = await getCargoSemverChecksAsset(getPlatformMatchingTarget());

    core.info(`downloading cargo-semver-checks from ${url}`);
    const tarballPath = await toolCache.downloadTool(url, undefined, `token ${getGitHubToken()}`, {
        accept: "application/octet-stream",
    });

    if (digest) {
        const [algorithm, expectedHash] = digest.split(":");
        const actualHash = crypto
            .createHash(algorithm)
            .update(new Uint8Array(fs.readFileSync(tarballPath)))
            .digest("hex");
        if (actualHash !== expectedHash) {
            throw new Error(
                `Checksum verification failed for downloaded binary.\nExpected: ${digest}\nActual:   ${algorithm}:${actualHash}`,
            );
        }
        core.info(`Checksum verified: ${digest}`);
    } else {
        core.warning(
            "No checksum available for this release asset; skipping integrity verification.",
        );
    }

    core.info(`extracting ${tarballPath}`);
    const binPath = await toolCache.extractTar(tarballPath, undefined, ["xz"]);

    core.addPath(binPath);
}

async function installCargoSemverChecksUsingCargo(cargo: rustCore.Cargo): Promise<void> {
    await cargo.call(["install", "cargo-semver-checks", "--locked"]);
}

async function installCargoSemverChecks(cargo: rustCore.Cargo): Promise<void> {
    if ((await io.which("cargo-semver-checks")) != "") {
        return;
    }

    core.info("cargo-semver-checks is not installed, installing now...");

    try {
        await installCargoSemverChecksFromPrecompiledBinary();
    } catch (error) {
        core.info("Failed to download precompiled binary of cargo-semver-checks.");
        core.info(`Error: ${getErrorMessage(error)}`);
        core.info("Installing using cargo install...");

        await installCargoSemverChecksUsingCargo(cargo);
    }
}

async function run(): Promise<void> {
    await validateSubscription();
    const manifestPath = path.resolve(rustCore.input.getInput("manifest-path") || "./");
    const manifestDir = path.extname(manifestPath) ? path.dirname(manifestPath) : manifestPath;

    await installRustUpIfRequested();

    const cargo = await rustCore.Cargo.get();

    await installCargoSemverChecks(cargo);

    const cache = new RustdocCache(
        cargo,
        path.join(CARGO_TARGET_DIR, "semver-checks", "cache"),
        manifestDir,
    );

    await cache.restore();
    await runCargoSemverChecks(cargo);
    await cache.save();
}

async function main() {
    try {
        await run();
    } catch (error) {
        core.setFailed(getErrorMessage(error));
    }
}

main();
