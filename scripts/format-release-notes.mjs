#!/usr/bin/env node
import { readFileSync } from "node:fs";

const CATEGORY_RULES = [
  { tag: "new", icon: "✨", label: "New", pattern: /^(?:feat|feature|add|new)\b/i },
  { tag: "fix", icon: "🐛", label: "Fix", pattern: /^(?:fix|fixed|resolve|prevent|repair|hotfix)\b/i },
  { tag: "speed", icon: "⚡", label: "Speed", pattern: /^(?:perf|speed|faster|cache|optimi[sz]e|stream|suspend)\b/i },
  { tag: "polish", icon: "🎨", label: "Polish", pattern: /^(?:style|ui|polish|hover|animat|align|center|tidy|theme|dark|corner)\b/i },
];

const NOISE_PATTERNS = [
  /^merge\s+(?:pull request|branch|remote-tracking)/i,
  /^bump\s+(?:version\s+)?to\s+v?\d+\.\d+\.\d+/i,
  /^chore(?:\([^)]+\))?:\s*bump\s+version/i,
  /^v?\d+\.\d+\.\d+\s*$/i,
  /^prepare\s+v?\d+\.\d+\.\d+/i,
  /^update\s+(?:cargo|package)-lock/i,
  /^fix\(deps\):\s*update\s+\S+\s+crate/i,
];

export function stripConventionalPrefix(text) {
  let clean = text
    .replace(/^[-*•]\s+/, "")
    .replace(/\s+by\s+@[\w-]+\s+in\s+https?:\/\/\S+$/i, "")
    .replace(/\s*\(#\d+\)\s*$/, "")
    .replace(/^v?\d+\.\d+\.\d+:\s*/i, "")
    .trim();

  const prefixMatch = clean.match(
    /^(feat|feature|fix|style|chore|ci|perf|refactor|docs)(?:\([^)]+\))?:\s*(.+)$/i
  );
  const prefix = prefixMatch ? prefixMatch[1].toLowerCase() : "";
  if (prefixMatch) {
    clean = prefixMatch[2].trim();
  }

  clean = clean
    .replace(/[;,]\s*(?:and\s+)?bump\s+(?:version\s+)?to\s+v?[\d.]+$/i, "")
    .trim();

  return { prefix, text: clean };
}

export function classifyItem(prefix, text) {
  const probe = prefix ? `${prefix} ${text}` : text;
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(probe)) {
      return rule;
    }
  }
  if (/\b(?:fix|fixed|crash|bug|prevent|broken|missing|restore)\b/i.test(text)) {
    return CATEGORY_RULES[1];
  }
  if (/\b(?:faster|speed|memory|cpu|cache|suspend|stream|smaller|size)\b/i.test(text)) {
    return CATEGORY_RULES[2];
  }
  if (/\b(?:hover|animation|button|layout|corner|theme|dark|icon|ui|settings)\b/i.test(text)) {
    return CATEGORY_RULES[3];
  }
  return CATEGORY_RULES[0];
}

export function formatReleaseNotesFromSubjects(subjects) {
  const items = [];
  const seen = new Set();

  for (const rawSubject of subjects) {
    const trimmed = String(rawSubject || "").trim();
    if (!trimmed) continue;
    if (/^#{1,6}\s+what'?s changed/i.test(trimmed)) continue;
    if (/^\*\*full changelog\*\*/i.test(trimmed) || /^full changelog:/i.test(trimmed)) continue;
    if (/^---+$/.test(trimmed)) continue;
    if (NOISE_PATTERNS.some((pattern) => pattern.test(trimmed))) continue;

    const { prefix, text } = stripConventionalPrefix(trimmed);
    if (!text || NOISE_PATTERNS.some((pattern) => pattern.test(text))) continue;

    // Split dense comma/semicolon lists from release commits into punchy bullets
    const parts =
      text.includes(",") && text.length > 72
        ? text.split(/\s*,\s*(?:and\s+)?|\s*;\s*/).filter(Boolean)
        : [text];

    for (let part of parts) {
      part = part.replace(/^and\s+/i, "").trim();
      if (!part || part.length < 4) continue;
      if (NOISE_PATTERNS.some((pattern) => pattern.test(part))) continue;
      const category = classifyItem(prefix, part);
      const sentence = part.charAt(0).toUpperCase() + part.slice(1).replace(/\.$/, "");
      const key = sentence.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(`- ${category.icon} **${category.label}:** ${sentence}.`);
      if (items.length >= 8) break;
    }
    if (items.length >= 8) break;
  }

  if (items.length === 0) {
    return "- ✨ **Update:** Fresh polish, stability tweaks, and under-the-hood improvements.";
  }
  return items.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv.includes("--stdin")
    ? readFileSync(0, "utf8")
    : process.env.RELEASE_INPUT || "";
  const lines = input.split(/\r?\n/).filter(Boolean);
  process.stdout.write(formatReleaseNotesFromSubjects(lines));
}
