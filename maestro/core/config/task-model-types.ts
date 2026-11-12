import type { ThinkingLevel } from "../types.ts";

export const TASK_CATEGORIES = [
	"coding",
	"review",
	"recon",
	"qa",
	"architecture",
	"docs",
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];
export const TASK_CATEGORY_DESCRIPTIONS = {
	coding: "Implementation workers",
	review: "Code reviewers",
	recon: "Reconnaissance scouts",
	qa: "Software and test runners",
	architecture: "Planning and diagnosis",
	docs: "Documentation workers",
} satisfies Record<TaskCategory, string>;
export type TaskPreferences = Partial<Record<TaskCategory, string[]>>;
export type TaskThinkingPreferences = Partial<
	Record<TaskCategory, ThinkingLevel>
>;
export interface TaskPreferencesMeta {
	generatedAt: string;
	method: RankingBasis["kind"];
}
/**
 * What a proposed ranking rests on, as the proposing model submitted it. It
 * travels with one write for review and is never saved; `tasksMeta.method`
 * keeps only its kind.
 */
export type RankingBasis =
	| { kind: "registry-only" }
	| {
			kind: "research";
			sources: [ResearchSource, ...ResearchSource[]];
			uncertainty: string;
	  };
export interface ResearchSource {
	/** An http(s) page the model consulted in this run. */
	url: string;
	/** How that source changed or supported the ranking. */
	influence: string;
}
