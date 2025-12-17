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
import { DrawTool } from "./DrawTool";
import { ShapeTool } from "./ShapeTool";
import { FormTool } from "./FormTool";
import { StampTool } from "./StampTool";

export const toolHandlers: Record<string, ToolHandler> = {
  text: TextTool,
  highlight: HighlightTool,
  callout: CalloutTool,
  redact: RedactTool,
  selectText: SelectTextTool,
  draw: DrawTool,
  shape: ShapeTool,
  form: FormTool,
  stamp: StampTool,
};

export { TextTool, HighlightTool, CalloutTool, RedactTool, SelectTextTool, DrawTool, ShapeTool, FormTool, StampTool };
export { normalizeSelectionToRect, validatePDFRect } from "./coordinateHelpers";
export type { ToolHandler, ToolContext } from "./types";

