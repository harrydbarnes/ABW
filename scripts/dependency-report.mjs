import { spawnSync } from "node:child_process";
import { appendFile, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const sections = ["# Dependency update report", "This check reports updates only. It does not modify dependencies or create PRs, issues, or commits."];

function command(executable, args, allowedStatuses = [0]) {
  const result = spawnSync(executable, args, { cwd: root, encoding: "utf8", timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (!allowedStatuses.includes(result.status)) {
    throw new Error(`${executable} exited with ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result;
}

async function section(name, check) {
  sections.push(`## ${name}`);
  try {
    sections.push(await check());
  } catch (error) {
    sections.push(`Check failed: ${error.message}`);
    process.exitCode = 1;
  }
}

function cell(value) {
  return String(value).replaceAll("|", "\\|").replace(/[\r\n]/g, " ");
}

await section("npm", async () => {
  if (!process.env.npm_execpath) throw new Error("Run this script with npm run dependencies:report.");
  const result = command(process.execPath, [process.env.npm_execpath, "outdated", "--json"], [0, 1]);
  const outdated = JSON.parse(result.stdout || "{}");
  if (outdated.error) throw new Error(outdated.error.summary);
  const entries = Object.entries(outdated);
  if (!entries.length) return "All installed npm dependencies are current.";
  return [
    "Wanted respects package.json ranges; latest may require a major migration.\n",
    "| Package | Installed | Wanted | Latest |",
    "| --- | --- | --- | --- |",
    ...entries.map(([name, versions]) => `| ${[name, versions.current, versions.wanted, versions.latest].map(cell).join(" | ")} |`),
  ].join("\n");
});

await section("Cargo compatible updates", async () => {
  const lockPath = new URL("../src-tauri/Cargo.lock", import.meta.url);
  const before = await readFile(lockPath);
  const result = command("cargo", ["update", "--manifest-path", "src-tauri/Cargo.toml", "--dry-run", "--color", "never"]);
  if (!before.equals(await readFile(lockPath))) throw new Error("Cargo.lock changed during the dry run.");
  return `Updates stay within Cargo.toml ranges; major migrations require separate review.\n\n\`\`\`text\n${(result.stdout + result.stderr).trim()}\n\`\`\``;
});

async function github(path, allowMissing = false) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
  return response.json();
}

await section("GitHub Actions", async () => {
  const directory = new URL("../.github/workflows/", import.meta.url);
  const refs = new Map();
  for (const file of await readdir(directory)) {
    if (!/\.ya?ml$/.test(file)) continue;
    const workflow = parse(await readFile(new URL(file, directory), "utf8"));
    for (const job of Object.values(workflow.jobs || {})) {
      for (const item of [job, ...(job.steps || [])]) {
        const uses = item.uses;
        if (typeof uses !== "string" || uses.startsWith("./") || uses.startsWith("docker://")) continue;
        const [repository, ref] = uses.split("@");
        if (repository.split("/").length !== 2 || !ref) throw new Error(`Unsupported action reference: ${uses}`);
        refs.set(uses, { repository, ref });
      }
    }
  }
  const rows = [];
  for (const { repository, ref } of refs.values()) {
    const release = await github(`repos/${repository}/releases/latest`, true);
    if (!release) {
      rows.push(`| ${cell(repository)} | ${cell(ref.slice(0, 12))} | No published release; review the pin manually |`);
      continue;
    }
    let { object } = await github(`repos/${repository}/git/ref/tags/${encodeURIComponent(release.tag_name)}`);
    while (object.type === "tag") {
      ({ object } = await github(`repos/${repository}/git/tags/${object.sha}`));
    }
    const status = ref === object.sha || ref === release.tag_name ? "Current" : "Update available";
    rows.push(`| ${cell(repository)} | ${cell(ref.slice(0, 12))} | ${cell(release.tag_name)}: ${status} (${object.sha}) |`);
  }
  return ["| Action | Current pin | Latest stable release |", "| --- | --- | --- |", ...rows].join("\n");
});

const report = `${sections.join("\n\n")}\n`;
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
