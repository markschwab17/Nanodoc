/**
 * Help Dialog Component
 * 
 * Searchable help manual with tools and keyboard shortcuts
 */

import { useState, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Search, MousePointer2, FileText, Type, ZoomIn, ArrowLeft } from "lucide-react";

interface HelpSection {
  id: string;
  title: string;
  icon?: React.ReactNode;
  items: HelpItem[];
}

interface HelpItem {
  id: string;
  title: string;
  description: string;
  shortcut?: string;
  category: string;
}

const helpSections: HelpSection[] = [
  {
    id: "tools",
    title: "Tools",
    icon: <MousePointer2 className="h-4 w-4" />,
    items: [
      {
        id: "select",
        title: "Select Tool",
        description: "Select and move annotations, text boxes, and highlights. Click and drag to move selected items.",
        shortcut: "Ctrl/Cmd + A",
        category: "tools",
      },
      {
        id: "selectText",
        title: "Select Text Tool",
        description: "Select text from the PDF document. Click and drag to select text, then copy or highlight it.",
        category: "tools",
      },
      {
        id: "pan",
        title: "Pan Tool",
        description: "Move around the PDF by clicking and dragging. You can also hold Space and drag, or use the Pan tool.",
        category: "tools",
      },
      {
        id: "text",
        title: "Text Annotation",
        description: "Add text boxes to your PDF. Click anywhere on the page to create a text box. Format text with bold, italic, underline, and more.",
        shortcut: "Ctrl/Cmd + T",
        category: "tools",
      },
      {
        id: "highlight",
        title: "Highlight Text",
        description: "Highlight text in your PDF. Select text with the Select Text tool, then use the Highlight tool to add highlights.",
        shortcut: "Ctrl/Cmd + H",
        category: "tools",
      },
      {
        id: "redact",
        title: "Redact Tool",
        description: "Permanently remove content from your PDF. Draw over areas you want to redact. This action cannot be undone.",
        shortcut: "Ctrl/Cmd + R",
        category: "tools",
      },
    ],
  },
  {
    id: "file",
    title: "File Operations",
    icon: <FileText className="h-4 w-4" />,
    items: [
      {
        id: "open",
        title: "Open PDF",
        description: "Open a PDF file from your computer. You can also drag and drop PDF files into the editor.",
        shortcut: "Ctrl/Cmd + O",
        category: "file",
      },
      {
        id: "save",
        title: "Save PDF",
        description: "Save your PDF with all annotations and edits. If the file has a path, it saves directly. Otherwise, use Save As.",
        shortcut: "Ctrl/Cmd + S",
        category: "file",
      },
      {
        id: "saveAs",
        title: "Save As",
        description: "Save your PDF to a new location with a new name.",
        category: "file",
      },
      {
        id: "export",
        title: "Export",
        description: "Export your PDF to other formats like images or other file types.",
        category: "file",
      },
      {
        id: "print",
        title: "Print PDF",
        description: "Print your PDF document. Configure print settings including page range and layout.",
        shortcut: "Ctrl/Cmd + P",
        category: "file",
      },
      {
        id: "close",
        title: "Close Tab",
        description: "Close the current PDF document tab.",
        shortcut: "Ctrl/Cmd + W",
        category: "file",
      },
    ],
  },
  {
    id: "navigation",
    title: "Navigation",
    icon: <ArrowLeft className="h-4 w-4" />,
    items: [
      {
        id: "prevPage",
        title: "Previous Page",
        description: "Navigate to the previous page in the document.",
        shortcut: "Arrow Left / Arrow Up",
        category: "navigation",
      },
      {
        id: "nextPage",
        title: "Next Page",
        description: "Navigate to the next page in the document.",
        shortcut: "Arrow Right / Arrow Down",
        category: "navigation",
      },
      {
        id: "firstPage",
        title: "First Page",
        description: "Jump to the first page of the document.",
        shortcut: "Home",
        category: "navigation",
      },
      {
        id: "lastPage",
        title: "Last Page",
        description: "Jump to the last page of the document.",
        shortcut: "End",
        category: "navigation",
      },
    ],
  },
  {
    id: "editing",
    title: "Editing",
    icon: <Type className="h-4 w-4" />,
    items: [
      {
        id: "undo",
        title: "Undo",
        description: "Undo the last action you performed.",
        shortcut: "Ctrl/Cmd + Z",
        category: "editing",
      },
      {
        id: "redo",
        title: "Redo",
        description: "Redo the last undone action.",
        shortcut: "Ctrl/Cmd + Y or Ctrl/Cmd + Shift + Z",
        category: "editing",
      },
      {
        id: "copyPages",
        title: "Copy Pages",
        description: "Copy selected pages from the thumbnail panel. Select pages and press Ctrl/Cmd + C.",
        shortcut: "Ctrl/Cmd + C",
        category: "editing",
      },
      {
        id: "pastePages",
        title: "Paste Pages",
        description: "Paste copied pages into the document. Press Ctrl/Cmd + V after copying pages.",
        shortcut: "Ctrl/Cmd + V",
        category: "editing",
      },
    ],
  },
  {
    id: "zoom",
    title: "Zoom",
    icon: <ZoomIn className="h-4 w-4" />,
    items: [
      {
        id: "zoomIn",
        title: "Zoom In",
        description: "Increase the zoom level of the PDF viewer.",
        shortcut: "Ctrl/Cmd + =",
        category: "zoom",
      },
      {
        id: "zoomOut",
        title: "Zoom Out",
        description: "Decrease the zoom level of the PDF viewer.",
        shortcut: "Ctrl/Cmd + -",
        category: "zoom",
      },
      {
        id: "zoomReset",
        title: "Reset Zoom",
        description: "Reset the zoom level to 100%.",
        shortcut: "Ctrl/Cmd + 0",
        category: "zoom",
      },
    ],
  },
  {
    id: "textFormatting",
    title: "Text Formatting",
    icon: <Type className="h-4 w-4" />,
    items: [
      {
        id: "bold",
        title: "Bold",
        description: "Make selected text bold. Select text in a text box and press Ctrl/Cmd + B.",
        shortcut: "Ctrl/Cmd + B",
        category: "textFormatting",
      },
      {
        id: "italic",
        title: "Italic",
        description: "Make selected text italic. Select text in a text box and press Ctrl/Cmd + I.",
        shortcut: "Ctrl/Cmd + I",
        category: "textFormatting",
      },
      {
        id: "underline",
        title: "Underline",
        description: "Underline selected text. Select text in a text box and press Ctrl/Cmd + U.",
        shortcut: "Ctrl/Cmd + U",
        category: "textFormatting",
      },
      {
        id: "alignLeft",
        title: "Align Left",
        description: "Align text to the left. Select text in a text box and press Ctrl/Cmd + L.",
        shortcut: "Ctrl/Cmd + L",
        category: "textFormatting",
      },
      {
        id: "alignCenter",
        title: "Align Center",
        description: "Center align text. Select text in a text box and press Ctrl/Cmd + E.",
        shortcut: "Ctrl/Cmd + E",
        category: "textFormatting",
      },
      {
        id: "alignRight",
        title: "Align Right",
        description: "Align text to the right. Select text in a text box and press Ctrl/Cmd + R.",
        shortcut: "Ctrl/Cmd + R",
        category: "textFormatting",
      },
    ],
  },
  {
    id: "view",
    title: "View",
    icon: <FileText className="h-4 w-4" />,
    items: [
      {
        id: "readMode",
        title: "Read Mode",
        description: "Toggle read-only mode. In read mode, editing tools are disabled.",
        shortcut: "R",
        category: "view",
      },
    ],
  },
];

interface HelpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function HelpDialog({ open, onOpenChange }: HelpDialogProps) {
  const [searchQuery, setSearchQuery] = useState("");

  // Filter help items based on search query
  const filteredSections = useMemo(() => {
    if (!searchQuery.trim()) {
      return helpSections;
    }

    const query = searchQuery.toLowerCase();
    return helpSections
      .map((section) => ({
        ...section,
        items: section.items.filter(
          (item) =>
            item.title.toLowerCase().includes(query) ||
            item.description.toLowerCase().includes(query) ||
            item.shortcut?.toLowerCase().includes(query) ||
            item.category.toLowerCase().includes(query)
        ),
      }))
      .filter((section) => section.items.length > 0);
  }, [searchQuery]);

  const formatShortcut = (shortcut?: string) => {
    if (!shortcut) return null;
    
    // Replace Ctrl/Cmd with platform-specific key
    const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPod|iPad/i.test(navigator.platform);
    const key = isMac ? "⌘" : "Ctrl";
    
    return shortcut
      .replace(/Ctrl\/Cmd/g, key)
      .replace(/Ctrl/g, "Ctrl")
      .replace(/Cmd/g, "⌘")
      .split(" + ")
      .map((k) => k.trim());
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Help & Keyboard Shortcuts
          </DialogTitle>
          <DialogDescription>
            Search for tools, features, and keyboard shortcuts
          </DialogDescription>
        </DialogHeader>

        {/* Search Bar */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search for tools, shortcuts, or features..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            autoFocus
          />
        </div>

        {/* Help Content */}
        <div className="flex-1 overflow-y-auto pr-2 space-y-6 mt-4">
          {filteredSections.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Search className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium">No results found</p>
              <p className="text-sm">Try a different search term</p>
            </div>
          ) : (
            filteredSections.map((section) => (
              <div key={section.id} className="space-y-3">
                <div className="flex items-center gap-2 text-lg font-semibold border-b pb-2">
                  {section.icon}
                  <h3>{section.title}</h3>
                </div>
                <div className="space-y-2">
                  {section.items.map((item) => {
                    const shortcutKeys = formatShortcut(item.shortcut);
                    return (
                      <div
                        key={item.id}
                        className="p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <h4 className="font-medium">{item.title}</h4>
                            </div>
                            <p className="text-sm text-muted-foreground">
                              {item.description}
                            </p>
                          </div>
                          {shortcutKeys && (
                            <div className="flex items-center gap-1 flex-shrink-0">
                              {shortcutKeys.map((key, idx) => (
                                <span key={idx}>
                                  <kbd className="px-2 py-1 text-xs font-semibold text-foreground bg-muted border border-border rounded shadow-sm">
                                    {key}
                                  </kbd>
                                  {idx < shortcutKeys.length - 1 && (
                                    <span className="mx-1 text-muted-foreground">+</span>
                                  )}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

