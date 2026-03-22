/** Shared types for contract redline data exchanged between CTO and Nanodoc. */

export interface RedlineAnnotationData {
  id: string;
  type: "strikethrough" | "comment";
  pageNumber: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  selectedText?: string;
  quads?: number[][];
  color?: string;
  commentAuthor?: string;
  commentContent?: string;
  redlineSeverity?: "critical" | "high" | "medium" | "low" | "info";
  redlineSuggestion?: string;
  redlineSourceId?: string;
  redlineCategory?: string;
}

export interface ContractRedlineResponse {
  contractId: string;
  contractTitle: string;
  riskScore: number;
  riskLevel: string;
  annotations: RedlineAnnotationData[];
}
