/**
 * Tool Registry
 * 
 * Maps tool names to their handlers
 */

import type { ToolHandler } from "./types";
import { TextTool } from "./TextTool";
import { HighlightTool } from "./HighlightTool";
import { CalloutTool } from "./CalloutTool";
import { RedactTool } from "./RedactTool";
import { SelectTextTool } from "./SelectTextTool";

export const toolHandlers: Record<string, ToolHandler> = {
  text: TextTool,
  highlight: HighlightTool,
  callout: CalloutTool,
  redact: RedactTool,
  selectText: SelectTextTool,
};

export { TextTool, HighlightTool, CalloutTool, RedactTool, SelectTextTool };
export { normalizeSelectionToRect, validatePDFRect } from "./coordinateHelpers";
export type { ToolHandler, ToolContext } from "./types";

