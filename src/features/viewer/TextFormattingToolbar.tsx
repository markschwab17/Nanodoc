/**
 * Text Formatting Toolbar Component
 * 
 * Toolbar for formatting text in the rich text editor.
 * Appears at the top of the screen when editing text annotations.
 */

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Bold,
  Italic,
  Underline,
  List,
  ListOrdered,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Palette,
  Type,
} from "lucide-react";
import { HexColorPicker } from "react-colorful";

interface TextFormattingToolbarProps {
  onFormat: (command: string, value?: string) => void;
  onFontChange: (font: string) => void;
  onFontSizeChange: (size: number) => void;
  onColorChange: (color: string) => void;
  onBackgroundToggle?: (enabled: boolean) => void;
  onBackgroundColorChange?: (color: string) => void;
  defaultFont?: string;
  defaultFontSize?: number;
  defaultColor?: string;
  defaultHasBackground?: boolean;
  defaultBackgroundColor?: string;
}

export function TextFormattingToolbar({
  onFormat,
  onFontChange,
  onFontSizeChange,
  onColorChange,
  onBackgroundToggle,
  onBackgroundColorChange,
  defaultFont = "Arial",
  defaultFontSize = 12,
  defaultColor = "#000000",
  defaultHasBackground = false,
  defaultBackgroundColor = "#ffffff",
}: TextFormattingToolbarProps) {
  const [fontSize, setFontSize] = useState(defaultFontSize);
  const [fontFamily, setFontFamily] = useState(defaultFont);
  const [color, setColor] = useState(defaultColor);
  const [hasBackground, setHasBackground] = useState(defaultHasBackground);
  const [backgroundColor, setBackgroundColor] = useState(defaultBackgroundColor);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showBackgroundColorPicker, setShowBackgroundColorPicker] = useState(false);


  // Sync state with default props when they change (e.g., when switching between annotations)
  useEffect(() => {
    setFontSize(defaultFontSize);
  }, [defaultFontSize]);

  useEffect(() => {
    setFontFamily(defaultFont);
  }, [defaultFont]);

  useEffect(() => {
    setColor(defaultColor);
  }, [defaultColor]);

  useEffect(() => {
    setHasBackground(defaultHasBackground);
  }, [defaultHasBackground]);

  useEffect(() => {
    setBackgroundColor(defaultBackgroundColor);
  }, [defaultBackgroundColor]);

  // Always show toolbar when PDF is loaded (no longer conditional on activeTool)

  // Get the active contentEditable element and preserve selection
  const getActiveEditor = (): { editor: HTMLElement | null; selection: Selection | null } => {
    const activeElement = document.activeElement as HTMLElement;
    let editor: HTMLElement | null = null;
    
    // Only use the editor if it's both contentEditable AND currently focused
    // This ensures we only style the actively focused text box
    if (activeElement && activeElement.hasAttribute("contenteditable") && 
        activeElement.getAttribute("data-rich-text-editor") === "true" &&
        activeElement.isContentEditable) {
      editor = activeElement;
    }
    
    // Don't fallback to other editors - only style the focused one
    const selection = window.getSelection();
    return { editor, selection };
  };

  const handleFontSizeChange = (value: number[]) => {
    const newSize = value[0];
    setFontSize(newSize);
    // Only update annotation through callback - don't manipulate DOM directly
    onFontSizeChange(newSize);
    
    const { editor, selection } = getActiveEditor();
    if (!editor) {
      // If no editor is active, the change will apply to new annotations
      return;
    }
    
    // Focus the editor first
    editor.focus();
    
    // Apply font size to selected text only (if there's a selection)
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (!range.collapsed) {
        // If there's a selection, wrap it in a span with the new font size
        const span = document.createElement("span");
        span.style.fontSize = `${newSize}px`;
        try {
          range.surroundContents(span);
        } catch (e) {
          // If surroundContents fails, try a different approach
          const contents = range.extractContents();
          span.appendChild(contents);
          range.insertNode(span);
        }
        // Restore selection
        const newRange = document.createRange();
        newRange.selectNodeContents(span);
        const newSelection = window.getSelection();
        if (newSelection) {
          newSelection.removeAllRanges();
          newSelection.addRange(newRange);
        }
      }
      // If no selection, the annotation update will handle the base font size
    }
    // Base font size is handled by RichTextEditor from annotation prop
  };

  const handleFontChange = (font: string) => {
    setFontFamily(font);
    // Only update annotation through callback - don't manipulate DOM directly
    onFontChange(font);
    
    const { editor, selection } = getActiveEditor();
    if (!editor) {
      // If no editor is active, the change will apply to new annotations
      return;
    }
    
    // Apply font change to selected text only (if there's a selection)
    // Use execCommand for font name on selection
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      // Only apply to selection if it's within our editor
      if (editor.contains(range.commonAncestorContainer) && !range.collapsed) {
        const success = document.execCommand("fontName", false, font);
        if (!success) {
          // Fallback: apply via CSS span
          const span = document.createElement("span");
          span.style.fontFamily = font;
          try {
            range.surroundContents(span);
          } catch (e) {
            const contents = range.extractContents();
            span.appendChild(contents);
            range.insertNode(span);
          }
        }
      }
      // If no selection, the annotation update will handle the base font family
    }
    
    // Focus editor after a short delay (after dropdown closes)
    setTimeout(() => {
      if (document.activeElement?.tagName !== 'SELECT') {
        editor.focus();
      }
    }, 150);
  };

  const handleColorChange = (newColor: string) => {
    setColor(newColor);
    // Only update annotation through callback - don't manipulate DOM directly
    onColorChange(newColor);
    
    const { editor, selection } = getActiveEditor();
    if (!editor) {
      // If no editor is active, the change will apply to new annotations
      return;
    }
    
    editor.focus();
    
    // Apply color to selected text only (if there's a selection)
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (!range.collapsed) {
        // Use execCommand for color on selection
        const success = document.execCommand("foreColor", false, newColor);
        if (!success) {
          // Fallback: apply via CSS span
          const span = document.createElement("span");
          span.style.color = newColor;
          try {
            range.surroundContents(span);
          } catch (e) {
            const contents = range.extractContents();
            span.appendChild(contents);
            range.insertNode(span);
          }
        }
      }
      // If no selection, the annotation update will handle the base color
    }
    // Base color is handled by RichTextEditor from annotation prop
  };

  const handleFormat = (command: string, value?: string) => {
    const { editor } = getActiveEditor();
    if (!editor) {
      // If no editor is active, the command will apply when user starts typing
      return;
    }
    
    // Focus the editor first
    editor.focus();
    
    // Execute the command
    const success = document.execCommand(command, false, value);
    if (!success) {
      console.warn(`Failed to execute command: ${command}`);
    }
    onFormat(command, value);
  };

  return (
    <div className="flex items-center gap-2 p-2" data-formatting-toolbar="true">
      {/* Font Family */}
      <select
        value={fontFamily}
        onChange={(e) => handleFontChange(e.target.value)}
        className="h-8 px-2 text-sm border rounded bg-background"
        onMouseDown={(e) => {
          // Prevent the editor from stealing focus when clicking the select
          e.stopPropagation();
        }}
      >
        <option value="Arial">Arial</option>
        <option value="Helvetica">Helvetica</option>
        <option value="Times New Roman">Times New Roman</option>
        <option value="Courier New">Courier New</option>
        <option value="Verdana">Verdana</option>
        <option value="Georgia">Georgia</option>
        <option value="Comic Sans MS">Comic Sans MS</option>
      </select>

      {/* Font Size */}
      <div className="flex items-center gap-2 min-w-[120px]">
        <Type className="h-4 w-4 text-muted-foreground" />
        <Slider
          value={[fontSize]}
          onValueChange={handleFontSizeChange}
          min={8}
          max={72}
          step={1}
          className="flex-1"
        />
        <span className="text-xs text-muted-foreground w-8">{fontSize}</span>
      </div>

      <div className="h-6 w-px bg-border" />

      {/* Text Style Buttons */}
      <Button
        variant="outline"
        size="icon"
        className="h-8 w-8"
        onClick={() => handleFormat("bold")}
        title="Bold (Ctrl+B)"
      >
        <Bold className="h-4 w-4" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="h-8 w-8"
        onClick={() => handleFormat("italic")}
        title="Italic (Ctrl+I)"
      >
        <Italic className="h-4 w-4" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="h-8 w-8"
        onClick={() => handleFormat("underline")}
        title="Underline (Ctrl+U)"
      >
        <Underline className="h-4 w-4" />
      </Button>

      <div className="h-6 w-px bg-border" />

      {/* Alignment */}
      <Button
        variant="outline"
        size="icon"
        className="h-8 w-8"
        onClick={() => handleFormat("justifyLeft")}
        title="Align Left"
      >
        <AlignLeft className="h-4 w-4" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="h-8 w-8"
        onClick={() => handleFormat("justifyCenter")}
        title="Align Center"
      >
        <AlignCenter className="h-4 w-4" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="h-8 w-8"
        onClick={() => handleFormat("justifyRight")}
        title="Align Right"
      >
        <AlignRight className="h-4 w-4" />
      </Button>

      <div className="h-6 w-px bg-border" />

      {/* Lists */}
      <Button
        variant="outline"
        size="icon"
        className="h-8 w-8"
        onClick={() => handleFormat("insertUnorderedList")}
        title="Bullet List"
      >
        <List className="h-4 w-4" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="h-8 w-8"
        onClick={() => handleFormat("insertOrderedList")}
        title="Numbered List"
      >
        <ListOrdered className="h-4 w-4" />
      </Button>

      <div className="h-6 w-px bg-border" />

      {/* Paragraph Format */}
      <select
        onChange={(e) => {
          const value = e.target.value;
          if (value === "p") {
            handleFormat("formatBlock", "<p>");
          } else if (value === "h1") {
            handleFormat("formatBlock", "<h1>");
          } else if (value === "h2") {
            handleFormat("formatBlock", "<h2>");
          } else if (value === "h3") {
            handleFormat("formatBlock", "<h3>");
          }
        }}
        onMouseDown={(e) => {
          // Prevent the editor from stealing focus when clicking the select
          e.stopPropagation();
        }}
        className="h-8 px-2 text-sm border rounded bg-background"
        defaultValue="p"
      >
        <option value="p">Paragraph</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
      </select>

      <div className="h-6 w-px bg-border" />

      {/* Color Picker */}
      <Popover open={showColorPicker} onOpenChange={setShowColorPicker}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="icon" className="h-8 w-8">
            <Palette className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-3">
          <HexColorPicker color={color} onChange={handleColorChange} />
          <div
            className="mt-2 h-8 w-full rounded border"
            style={{ backgroundColor: color }}
          />
        </PopoverContent>
      </Popover>

      <div className="h-6 w-px bg-border" />

      {/* Background Toggle */}
      <Button
        variant={hasBackground ? "default" : "outline"}
        size="icon"
        className="h-8 w-8"
        onClick={() => {
          const newValue = !hasBackground;
          setHasBackground(newValue);
          onBackgroundToggle?.(newValue);
        }}
        title="Toggle Background"
      >
        <div className="h-4 w-4 border border-current" />
      </Button>

      {/* Background Color Picker - only show when background is enabled */}
      {hasBackground && (
        <Popover open={showBackgroundColorPicker} onOpenChange={setShowBackgroundColorPicker}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="icon" className="h-8 w-8">
              <div
                className="h-4 w-4 rounded border border-border"
                style={{ backgroundColor: backgroundColor }}
              />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-3">
            <HexColorPicker color={backgroundColor} onChange={(newColor) => {
              setBackgroundColor(newColor);
              onBackgroundColorChange?.(newColor);
            }} />
            <div
              className="mt-2 h-8 w-full rounded border"
              style={{ backgroundColor: backgroundColor }}
            />
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}







