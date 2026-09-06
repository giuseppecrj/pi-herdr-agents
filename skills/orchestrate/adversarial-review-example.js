// Request-local helpers for validating public subagent review deliveries.
// The extension does not import this file; it is not a runtime schema.
const REVIEW_REPORT_MAX_CHARS = 12_000;
const REVIEW_ERROR_MAX_CHARS = 4_000;
const REVIEW_SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);
const REVIEW_EVIDENCE = new Set(["reproduced", "trace-backed", "unverified"]);
const REVIEW_RESOLUTIONS = new Set(["candidate", "confirmed", "rejected"]);
const REVIEW_STATUS = new Set(["COMPLETE", "INCOMPLETE"]);

function reviewIsString(value) {
	return Object.prototype.toString.call(value) === "[object String]";
}

function reviewIsPlainObject(value) {
	return (
		value !== null &&
		Object.prototype.toString.call(value) === "[object Object]"
	);
}

function reviewObject(value, label) {
	if (!reviewIsPlainObject(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value;
}

function reviewString(value, label, maxChars = 1_000) {
	if (!reviewIsString(value) || value.length < 1 || value.length > maxChars) {
		throw new Error(`${label} must be a non-empty bounded string`);
	}
	return value;
}

function reviewStringArray(value, label, maximum = 20) {
	if (!Array.isArray(value) || value.length > maximum) {
		throw new Error(`${label} must be a bounded array`);
	}
	return value.map((entry, index) => reviewString(entry, `${label}[${index}]`));
}

function parseReviewJson(text) {
	if (!reviewIsString(text)) {
		throw new Error("report must be a string");
	}
	// Public delivery wraps the child's final message in a completion
	// presentation (prefix, model, and session lines), so the report is
	// recovered from the required single fenced block rather than the
	// whole delivered text.
	const trimmed = text.trim();
	const fences = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/gi)];
	if (fences.length > 1) {
		throw new Error("report must contain exactly one fenced JSON block");
	}
	const candidate = fences.length === 1 ? fences[0][1].trim() : trimmed;
	if (candidate.length > REVIEW_REPORT_MAX_CHARS) {
		throw new Error("report exceeds the request-local output bound");
	}
	try {
		return JSON.parse(candidate);
	} catch {
		throw new Error("report must be valid JSON in one fenced block");
	}
}

function validateReviewReport(value, options) {
	const serialized = JSON.stringify(value);
	if (!serialized || serialized.length > REVIEW_REPORT_MAX_CHARS) {
		throw new Error("report exceeds the request-local output bound");
	}
	const report = reviewObject(value, "report");
	const reviewerId = reviewString(report.reviewerId, "report.reviewerId", 100);
	if (reviewerId !== options.reviewerId) {
		throw new Error(
			"report reviewerId does not match its anonymous assignment",
		);
	}
	if (!REVIEW_STATUS.has(report.status)) {
		throw new Error("report status must be COMPLETE or INCOMPLETE");
	}
	const coverageGaps = reviewStringArray(report.coverageGaps, "coverageGaps");
	if (coverageGaps.length > 0 && report.status !== "INCOMPLETE") {
		throw new Error("coverage gaps require INCOMPLETE status");
	}
	if (!Array.isArray(report.findings) || report.findings.length > 20) {
		throw new Error("findings must be a bounded array");
	}

	const ids = new Set();
	const allowedIds = options.allowedFindingIds
		? new Set(options.allowedFindingIds)
		: undefined;
	const findings = report.findings.map((candidate, index) => {
		const finding = reviewObject(candidate, `findings[${index}]`);
		const id = reviewString(finding.id, `findings[${index}].id`, 100);
		if (ids.has(id)) throw new Error("finding IDs must be unique");
		ids.add(id);
		if (options.stage === "discovery") {
			if (!id.startsWith(`${options.reviewerId}-F`)) {
				throw new Error("discovery finding ID must use its reviewer prefix");
			}
		} else if (allowedIds && !allowedIds.has(id)) {
			throw new Error("finding ID is not from the supplied candidate set");
		}
		if (!REVIEW_SEVERITIES.has(finding.claimedSeverity)) {
			throw new Error("claimedSeverity must be P0, P1, P2, or P3");
		}
		if (
			finding.confirmedSeverity !== null &&
			!REVIEW_SEVERITIES.has(finding.confirmedSeverity)
		) {
			throw new Error("confirmedSeverity must be null or P0, P1, P2, or P3");
		}
		if (!REVIEW_EVIDENCE.has(finding.evidenceStatus)) {
			throw new Error("evidenceStatus is unsupported");
		}
		if (!REVIEW_RESOLUTIONS.has(finding.resolution)) {
			throw new Error("resolution must be candidate, confirmed, or rejected");
		}

		const provenance = reviewStringArray(
			finding.provenance,
			`findings[${index}].provenance`,
		);
		const preconditions = reviewStringArray(
			finding.preconditions,
			`findings[${index}].preconditions`,
		);
		const reproductionOrTrace = reviewStringArray(
			finding.reproductionOrTrace,
			`findings[${index}].reproductionOrTrace`,
		);
		if (options.stage === "discovery") {
			if (
				finding.resolution !== "candidate" ||
				finding.confirmedSeverity !== null
			) {
				throw new Error("discovery can only raise unconfirmed candidates");
			}
		} else if (finding.resolution === "confirmed") {
			if (
				finding.confirmedSeverity === null ||
				finding.evidenceStatus === "unverified" ||
				provenance.length === 0 ||
				reproductionOrTrace.length === 0
			) {
				throw new Error(
					"confirmation requires reproduced or trace-backed evidence",
				);
			}
		} else if (finding.resolution === "rejected") {
			if (
				finding.confirmedSeverity !== null ||
				finding.evidenceStatus === "unverified" ||
				provenance.length === 0 ||
				reproductionOrTrace.length === 0
			) {
				throw new Error(
					"rejection requires reproduced or trace-backed evidence",
				);
			}
		} else if (finding.confirmedSeverity !== null) {
			throw new Error("an unresolved candidate cannot have confirmed severity");
		}

		const canonical = {
			id,
			claimedSeverity: finding.claimedSeverity,
			confirmedSeverity: finding.confirmedSeverity,
			resolution: finding.resolution,
			location: reviewString(finding.location, `findings[${index}].location`),
			provenance,
			evidenceStatus: finding.evidenceStatus,
			preconditions,
			reproductionOrTrace,
			expected: reviewString(
				finding.expected,
				`findings[${index}].expected`,
				2_000,
			),
			actual: reviewString(finding.actual, `findings[${index}].actual`, 2_000),
			impact: reviewString(finding.impact, `findings[${index}].impact`, 2_000),
			minimalFix: reviewString(
				finding.minimalFix,
				`findings[${index}].minimalFix`,
				2_000,
			),
		};
		return canonical;
	});

	if (
		options.stage !== "discovery" &&
		findings.some(
			(finding) =>
				finding.resolution === "candidate" &&
				(finding.claimedSeverity === "P0" || finding.claimedSeverity === "P1"),
		) &&
		report.status !== "INCOMPLETE"
	) {
		throw new Error("unresolved serious candidates require INCOMPLETE status");
	}
	return { reviewerId, status: report.status, findings, coverageGaps };
}

function reviewRedactText(value, identityTokens = []) {
	let text = value;
	for (const token of identityTokens) {
		if (reviewIsString(token) && token.length > 0) {
			text = text.split(token).join("[redacted identity]");
		}
	}
	return text.replace(
		/(?:file:\/\/)?\/[^\s"'`]+\.jsonl\b/g,
		"[redacted session]",
	);
}

function reviewIdentityStripReport(value, identityTokens) {
	if (reviewIsString(value)) return reviewRedactText(value, identityTokens);
	if (Array.isArray(value)) {
		return value.map((entry) =>
			reviewIdentityStripReport(entry, identityTokens),
		);
	}
	if (reviewIsPlainObject(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key,
				reviewIdentityStripReport(entry, identityTokens),
			]),
		);
	}
	return value;
}

function reviewErrorEvidence(value, identityTokens = []) {
	const original = reviewIsString(value) ? value : String(value ?? "");
	const message = reviewRedactText(original, identityTokens);
	return {
		message: message.slice(0, REVIEW_ERROR_MAX_CHARS),
		truncated: message.length > REVIEW_ERROR_MAX_CHARS,
	};
}

function publicResultText(result) {
	if (!result || result.exitCode !== 0 || result.errorMessage) return null;
	const details = reviewIsPlainObject(result.details) ? result.details : {};
	const text = details.resultContent ?? result.content ?? result.summary;
	return reviewIsString(text) ? text : null;
}

function parseReviewResult(alias, result, options) {
	const text = publicResultText(result);
	if (!text) {
		const error = reviewErrorEvidence(
			result?.errorMessage ?? result?.error ?? "missing public subagent result",
			[result?.sessionFile, ...(options.identityTokens ?? [])],
		);
		return {
			original: result,
			valid: false,
			status: "INCOMPLETE",
			report: null,
			projection: {
				reviewerId: alias,
				outcome: "failure",
				code: result?.errorMessage ? "child_error" : "missing_result",
				retryable: false,
				error,
			},
		};
	}
	try {
		const report = validateReviewReport(parseReviewJson(text), {
			...options,
			reviewerId: alias,
		});
		return {
			original: result,
			valid: true,
			status: report.status,
			report,
			projection: {
				reviewerId: alias,
				outcome: "success",
				report: reviewIdentityStripReport(report, [
					result?.sessionFile,
					...(options.identityTokens ?? []),
				]),
			},
		};
	} catch (error) {
		return {
			original: result,
			valid: false,
			status: "INCOMPLETE",
			report: null,
			projection: {
				reviewerId: alias,
				outcome: "failure",
				code: "invalid_report",
				retryable: false,
				error: reviewErrorEvidence(
					error instanceof Error ? error.message : error,
					options.identityTokens,
				),
			},
		};
	}
}

function seriousUnverifiedCandidateIds(parsedDiscovery) {
	return parsedDiscovery.flatMap((parsed) =>
		parsed.valid
			? parsed.report.findings
					.filter(
						(finding) =>
							finding.resolution === "candidate" &&
							(finding.claimedSeverity === "P0" ||
								finding.claimedSeverity === "P1"),
					)
					.map((finding) => finding.id)
			: [],
	);
}

function resolveSeriousCandidates(candidateIds, parsedVerification) {
	const decisions = new Map(candidateIds.map((id) => [id, new Set()]));
	for (const parsed of parsedVerification) {
		if (!parsed.valid) continue;
		for (const finding of parsed.report.findings) {
			if (
				decisions.has(finding.id) &&
				(finding.resolution === "confirmed" ||
					finding.resolution === "rejected")
			) {
				decisions.get(finding.id).add(finding.resolution);
			}
		}
	}
	const confirmedCandidateIds = [];
	const rejectedCandidateIds = [];
	const unresolvedCandidateIds = [];
	for (const [id, resolutions] of decisions) {
		if (resolutions.size !== 1) unresolvedCandidateIds.push(id);
		else if (resolutions.has("confirmed")) confirmedCandidateIds.push(id);
		else rejectedCandidateIds.push(id);
	}
	return {
		confirmedCandidateIds,
		rejectedCandidateIds,
		resolvedCandidateIds: [...confirmedCandidateIds, ...rejectedCandidateIds],
		unresolvedCandidateIds,
	};
}

function reviewCoverageIncomplete(parsedResults, unresolvedCandidateIds = []) {
	return (
		unresolvedCandidateIds.length > 0 ||
		parsedResults.some(
			(parsed) => !parsed.valid || parsed.status === "INCOMPLETE",
		)
	);
}

// Parent-only helper. Call after all public discovery and verifier deliveries
// arrive; it does not launch children or impose a runner result envelope.
export function validatePublicReviewResults(input) {
	const discovery = input.discovery.map(({ alias, result }) =>
		parseReviewResult(alias, result, {
			stage: "discovery",
			identityTokens: input.identityTokens ?? [],
		}),
	);
	const candidateIds = seriousUnverifiedCandidateIds(discovery);
	const verification = input.verification.map(
		({ alias, result, candidateIds: ids }) =>
			parseReviewResult(alias, result, {
				stage: "verification",
				allowedFindingIds: ids,
				identityTokens: input.identityTokens ?? [],
			}),
	);
	const resolution = resolveSeriousCandidates(candidateIds, verification);
	return {
		status: reviewCoverageIncomplete(
			[...discovery, ...verification],
			resolution.unresolvedCandidateIds,
		)
			? "INCOMPLETE"
			: "COMPLETE",
		discovery,
		verification,
		resolution,
		projections: [...discovery, ...verification].map(
			(parsed) => parsed.projection,
		),
	};
}
