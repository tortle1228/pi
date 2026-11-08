import { existsSync, readFileSync } from "fs";

export interface ChangelogEntry {
	major: number;
	minor: number;
	patch: number;
	content: string;
}

/**
 * Parse changelog entries from CHANGELOG.md
 * Scans for ## lines and collects content until next ## or EOF
 */
export function parseChangelog(changelogPath: string): ChangelogEntry[] {
	if (!existsSync(changelogPath)) {
		return [];
	}

	try {
		const content = readFileSync(changelogPath, "utf-8");
		const lines = content.split("\n");
		const entries: ChangelogEntry[] = [];

		let currentLines: string[] = [];
		let currentVersion: { major: number; minor: number; patch: number } | null = null;

		for (const line of lines) {
			// Check if this is a version header (## [x.y.z] ...)
			if (line.startsWith("## ")) {
				// Save previous entry if exists
				if (currentVersion && currentLines.length > 0) {
					entries.push({
						...currentVersion,
						content: currentLines.join("\n").trim(),
					});
				}

				// Try to parse version from this line
				const versionMatch = line.match(/##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/);
				if (versionMatch) {
					currentVersion = {
						major: Number.parseInt(versionMatch[1], 10),
						minor: Number.parseInt(versionMatch[2], 10),
						patch: Number.parseInt(versionMatch[3], 10),
					};
					currentLines = [line];
				} else {
					// Reset if we can't parse version
					currentVersion = null;
					currentLines = [];
				}
			} else if (currentVersion) {
				// Collect lines for current version
				currentLines.push(line);
			}
		}

		// Save last entry
		if (currentVersion && currentLines.length > 0) {
			entries.push({
				...currentVersion,
				content: currentLines.join("\n").trim(),
			});
		}

		return entries;
	} catch (error) {
		console.error(`Warning: Could not parse changelog: ${error}`);
		return [];
	}
}

/**
 * Compare versions. Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
 */
export function compareVersions(v1: ChangelogEntry, v2: ChangelogEntry): number {
	if (v1.major !== v2.major) return v1.major - v2.major;
	if (v1.minor !== v2.minor) return v1.minor - v2.minor;
	return v1.patch - v2.patch;
}

/**
 * Get entries newer than lastVersion, or undefined when lastVersion has no major.minor.patch to compare against
 */
export function getNewEntries(entries: ChangelogEntry[], lastVersion: string): ChangelogEntry[] | undefined {
	// Read only the leading major.minor.patch, like the changelog headings, so a prerelease such as
	// 0.1.5-20261020.7 counts as 0.1.5 and its notes are not shown again on every launch (#11703).
	// Alternatives considered: plain string comparison orders 0.10.0 before 0.9.0; numeric localeCompare
	// works by accident and is locale-dependent; strict semver orders 0.1.5-x before 0.1.5, which repeats
	// the [0.1.5] notes forever.
	const parts = lastVersion.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
	if (!parts) return undefined;
	const last: ChangelogEntry = {
		major: Number(parts[1]),
		minor: Number(parts[2]),
		patch: Number(parts[3]),
		content: "",
	};

	return entries.filter((entry) => compareVersions(entry, last) > 0);
}
