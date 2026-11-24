import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyItem,
  formatReleaseNotesFromSubjects,
  stripConventionalPrefix,
} from "./format-release-notes.mjs";

test("stripConventionalPrefix removes bullets, PR metadata, version tags, and conventional prefixes", () => {
  assert.deepEqual(
    stripConventionalPrefix("- v0.1.43: feat(preview): add PDF text selection (#128)"),
    { prefix: "feat", text: "add PDF text selection" },
  );
  assert.deepEqual(
    stripConventionalPrefix("* fix(wrike): resolve Check PO panel by @octocat in https://github.com/org/repo/pull/99"),
    { prefix: "fix", text: "resolve Check PO panel" },
  );
  assert.deepEqual(
    stripConventionalPrefix("feat: restore calamine, and bump version to 0.1.43"),
    { prefix: "feat", text: "restore calamine" },
  );
});

test("classifyItem maps prefixes and keywords into release-note categories", () => {
  assert.equal(classifyItem("perf", "reduce memory footprint").label, "Speed");
  assert.equal(classifyItem("fix", "prevent crash on exit").label, "Fix");
  assert.equal(classifyItem("", "Polish dark theme corner radius").label, "Polish");
  assert.equal(classifyItem("feat", "add CSV export").label, "New");
});

test("formatReleaseNotesFromSubjects filters noise, deduplicates, splits long lists, and falls back", () => {
  const formatted = formatReleaseNotesFromSubjects([
    "## What's Changed",
    "Merge pull request #12 from org/branch",
    "chore(release): bump version to v0.1.43",
    "Update cargo-lock",
    "feat: restore calamine, add Show images, WebView2 memory target, row virtualization, and PDF tail prefetch",
    "- feat: restore calamine",
    "Reduce PDF memory usage",
    "**Full Changelog**: https://github.com/org/repo/compare/v0.1.42...v0.1.43",
  ]);
  const lines = formatted.split("\n");
  assert.equal(lines.length, 6);
  assert.match(lines[0], /Restore calamine\./);
  assert.match(lines[2], /\*\*New:\*\* WebView2 memory target\./);
  assert.match(lines[5], /\*\*Speed:\*\* Reduce PDF memory usage\./);

  assert.equal(
    formatReleaseNotesFromSubjects(["Merge branch 'main'", "v0.1.43", "---"]),
    "- ✨ **Update:** Fresh polish, stability tweaks, and under-the-hood improvements.",
  );
});
