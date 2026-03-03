/**
 * Tour step definitions for the editor and stitch views.
 */

export interface TourStep {
  /** data-tour attribute value to find the target element */
  target: string;
  title: string;
  description: string;
  placement: "top" | "bottom" | "left" | "right";
}

export const EDITOR_TOUR_STEPS: TourStep[] = [
  {
    target: "editor-page-sidebar",
    title: "Page Thumbnails",
    description:
      "Browse and reorder pages here. Click a page to jump to it, or drag pages to rearrange them.",
    placement: "right",
  },
  {
    target: "editor-viewer",
    title: "PDF Viewer",
    description:
      "Your main workspace. View, annotate, and edit your PDF document here. Scroll to navigate pages.",
    placement: "left",
  },
  {
    target: "editor-toolbar",
    title: "Toolbar",
    description:
      "All your editing tools live here. Let's walk through the key ones.",
    placement: "left",
  },
  {
    target: "editor-tool-select",
    title: "Select Tool",
    description:
      "Click to select and move annotations. Use this to reposition text boxes, shapes, and other elements.",
    placement: "left",
  },
  {
    target: "editor-tool-text",
    title: "Text Tool",
    description:
      "Click anywhere on the page to add a text box. Format with bold, italic, colors, and more from the toolbar above.",
    placement: "left",
  },
  {
    target: "editor-tool-highlight",
    title: "Highlight Tool",
    description:
      "Select text on the page and click Highlight to mark it. Great for reviewing documents.",
    placement: "left",
  },
  {
    target: "editor-tool-draw",
    title: "Draw Tool",
    description:
      "Freehand draw on your PDF. Use this for signatures, sketches, or quick markups.",
    placement: "left",
  },
  {
    target: "editor-tool-shape",
    title: "Shape Tool",
    description:
      "Add rectangles, circles, and arrows to your document. Hover to pick a shape type.",
    placement: "left",
  },
  {
    target: "editor-tool-stamp",
    title: "Stamp Tool",
    description:
      "Place stamps on your PDF. Choose from built-in stamps or create your own custom stamps.",
    placement: "left",
  },
  {
    target: "editor-undo-redo",
    title: "Undo / Redo",
    description:
      "Made a mistake? Undo and redo your changes with these buttons or keyboard shortcuts.",
    placement: "left",
  },
  {
    target: "editor-tool-help",
    title: "Help & Shortcuts",
    description:
      "View all keyboard shortcuts and tool descriptions. You can restart this tour from here anytime.",
    placement: "left",
  },
];

export const STITCH_TOUR_STEPS: TourStep[] = [
  {
    target: "stitch-add-pdf",
    title: "Add PDF Pages",
    description:
      "Start by adding PDF files. You can select which pages to place on the canvas.",
    placement: "bottom",
  },
  {
    target: "stitch-tools",
    title: "Canvas Tools",
    description:
      "Select and move tiles, pan around the canvas, and toggle resize lock for precise control.",
    placement: "bottom",
  },
  {
    target: "stitch-delete-tools",
    title: "Content Erasers",
    description:
      "Remove unwanted content from PDFs. 'Delete content' erases a region; 'Delete element' removes individual lines or shapes.",
    placement: "bottom",
  },
  {
    target: "stitch-align-tools",
    title: "Alignment Tools",
    description:
      "Point align matches two PDFs by selecting corresponding points. Scale align resizes one PDF to match another's scale.",
    placement: "bottom",
  },
  {
    target: "stitch-scale",
    title: "Scale Controls",
    description:
      "Set your drawing scale (e.g. 1\"=20') and resize the composition. Add a scale stamp to the exported PDF.",
    placement: "bottom",
  },
  {
    target: "stitch-selection-actions",
    title: "Selection Actions",
    description:
      "Select all tiles, change layer order (front/back), or delete selected tiles.",
    placement: "bottom",
  },
  {
    target: "stitch-export",
    title: "Export Options",
    description:
      "Download the stitched result as a PDF, or open it directly in the editor for further annotation.",
    placement: "bottom",
  },
  {
    target: "stitch-canvas-controls",
    title: "Canvas Settings",
    description:
      "Choose canvas size, zoom in/out, toggle edge snapping, and lock tiles in position.",
    placement: "top",
  },
];

export const TOUR_STEPS: Record<string, TourStep[]> = {
  editor: EDITOR_TOUR_STEPS,
  stitch: STITCH_TOUR_STEPS,
};
