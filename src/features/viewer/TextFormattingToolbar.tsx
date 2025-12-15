/**
 * Text Formatting Toolbar Component
 * 
 * Toolbar for formatting text in the rich text editor.
 * Appears at the top of the screen when editing text annotations.
 */

import { useState, useEffect, useRef } from "react";
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
  AlignLeft,
  AlignCenter,
  AlignRight,
  Palette,
  Type,
  Trash2,
} from "lucide-react";
// Removed HexColorPicker - using preset colors instead

interface TextFormattingToolbarProps {
  onFormat: (command: string, value?: string) => void;
  onFontChange: (font: string) => void;
  onFontSizeChange: (size: number) => void;
  onColorChange: (color: string) => void;
  onBackgroundToggle?: (enabled: boolean) => void;
  onBackgroundColorChange?: (color: string) => void;
  onDelete?: () => void;
  defaultFont?: string;
  defaultFontSize?: number;
  defaultColor?: string;
  defaultHasBackground?: boolean;
  defaultBackgroundColor?: string;
  isEditing?: boolean;
  hasSelection?: boolean; // Whether an annotation is currently selected
}

export function TextFormattingToolbar({
  onFormat,
  onFontChange,
  onFontSizeChange,
  onColorChange,
  onBackgroundToggle,
  onBackgroundColorChange,
  onDelete,
  defaultFont = "Arial",
  defaultFontSize = 12,
  defaultColor = "rgba(0, 0, 0, 1)",
  defaultHasBackground = true,
  defaultBackgroundColor = "rgba(255, 255, 255, 0)",
  isEditing = false,
  hasSelection = false,
}: TextFormattingToolbarProps) {
  const [fontSize, setFontSize] = useState(defaultFontSize);
  const [fontFamily, setFontFamily] = useState(defaultFont);
  const [color, setColor] = useState(defaultColor);
  const [hasBackground, setHasBackground] = useState(defaultHasBackground);
  const [backgroundColor, setBackgroundColor] = useState(defaultBackgroundColor);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showBackgroundColorPicker, setShowBackgroundColorPicker] = useState(false);
  
  // Refs to track if we should allow popover to close
  const colorPickerContentRef = useRef<HTMLDivElement>(null);
  const allowColorPickerCloseRef = useRef(true);
  const colorPickerTriggerRef = useRef<HTMLButtonElement>(null);
  
  // Handle clicks outside the popover manually
  useEffect(() => {
    if (!showColorPicker) {
      allowColorPickerCloseRef.current = true;
      return;
    }
    
    // Immediately set flag to prevent closing when popover opens
    allowColorPickerCloseRef.current = false;
    
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      
      // Check if click is inside popover content, trigger, or toolbar
      const isInsidePopover = colorPickerContentRef.current?.contains(target) ||
          target.closest('[data-formatting-toolbar]') ||
          target.closest('.react-colorful') ||
          target.closest('[data-radix-popover-content]') ||
          target.closest('[data-radix-slider-root]') ||
          target.closest('[data-radix-slider-track]') ||
          target.closest('[data-radix-slider-range]') ||
          target.closest('[data-radix-slider-thumb]') ||
          colorPickerTriggerRef.current?.contains(target);
      
      if (!isInsidePopover) {
        // Click is outside - allow closing
        allowColorPickerCloseRef.current = true;
        setShowColorPicker(false);
      } else {
        // Click is inside - prevent closing and force keep open
        allowColorPickerCloseRef.current = false;
        // Force keep open immediately
        requestAnimationFrame(() => {
          setShowColorPicker(true);
        });
      }
    };
    
    // Use capture phase to catch events early, listen to multiple event types
    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('click', handleClickOutside, true);
    document.addEventListener('pointerdown', handleClickOutside, true);
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
      document.removeEventListener('click', handleClickOutside, true);
      document.removeEventListener('pointerdown', handleClickOutside, true);
    };
  }, [showColorPicker]);
  
  // Preset colors (RGB values, opacity will be applied via slider)
  const presetColors = [
    { name: "Black", r: 0, g: 0, b: 0 },
    { name: "White", r: 255, g: 255, b: 255 },
    { name: "Red", r: 255, g: 0, b: 0 },
    { name: "Green", r: 0, g: 255, b: 0 },
    { name: "Blue", r: 0, g: 0, b: 255 },
    { name: "Yellow", r: 255, g: 255, b: 0 },
    { name: "Cyan", r: 0, g: 255, b: 255 },
    { name: "Magenta", r: 255, g: 0, b: 255 },
    { name: "Orange", r: 255, g: 165, b: 0 },
    { name: "Purple", r: 128, g: 0, b: 128 },
    { name: "Pink", r: 255, g: 192, b: 203 },
    { name: "Brown", r: 165, g: 42, b: 42 },
    { name: "Gray", r: 128, g: 128, b: 128 },
    { name: "Light Gray", r: 211, g: 211, b: 211 },
    { name: "Dark Gray", r: 64, g: 64, b: 64 },
    { name: "Navy", r: 0, g: 0, b: 128 },
  ];
  
  // Helper to convert RGB to rgba (full opacity)
  const rgbToRgba = (r: number, g: number, b: number): string => {
    return `rgba(${r}, ${g}, ${b}, 1)`;
  };
  
  // Get RGB values from rgba color string
  const getRgbFromColor = (color: string): { r: number; g: number; b: number } => {
    if (color.startsWith("rgba")) {
      const match = color.match(/rgba?\(([^)]+)\)/);
      if (match) {
        const values = match[1].split(",").map(v => parseInt(v.trim()));
        if (values.length >= 3) {
          return { r: values[0], g: values[1], b: values[2] };
        }
      }
    }
    // Default to black if parsing fails
    return { r: 0, g: 0, b: 0 };
  };
  
  // Check if a preset color matches the current color (ignoring opacity)
  const isPresetColorSelected = (preset: { r: number; g: number; b: number }): boolean => {
    const currentRgb = getRgbFromColor(color);
    return currentRgb.r === preset.r && currentRgb.g === preset.g && currentRgb.b === preset.b;
  };
  const [isBold, setIsBold] = useState(false);
  const [isItalic, setIsItalic] = useState(false);
  const [isUnderline, setIsUnderline] = useState(false);
  // Store saved selection to preserve it when input field gets focus
  const savedSelectionRef = useRef<{ range: Range; editor: HTMLElement } | null>(null);


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

  // Update toolbar state from editor content when editor becomes active or selection changes
  useEffect(() => {
    const updateFromEditor = () => {
      const { editor } = getActiveEditor();
      if (!editor) {
        // Reset formatting states when no editor
        setIsBold(false);
        setIsItalic(false);
        setIsUnderline(false);
        return;
      }

      // Only update formatting if editor is focused (to avoid stealing focus)
      // This ensures we only update when user is actively editing
      if (document.activeElement !== editor) {
        return;
      }
      
      try {
        const boldState = document.queryCommandState('bold');
        const italicState = document.queryCommandState('italic');
        const underlineState = document.queryCommandState('underline');
        
        setIsBold(boldState);
        setIsItalic(italicState);
        setIsUnderline(underlineState);
        
        // Try to read font size from selection or cursor position
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          // Get the container element (where the cursor/selection is)
          let container = range.commonAncestorContainer;
          if (container.nodeType === Node.TEXT_NODE) {
            container = container.parentElement || editor;
          } else {
            container = container as Element;
          }
          
          // Walk up the tree to find an element with font-size style
          let element: HTMLElement | null = container as HTMLElement;
          while (element && element !== editor) {
            const style = element.getAttribute('style');
            if (style && style.includes('font-size')) {
              const match = style.match(/font-size:\s*(\d+(?:\.\d+)?)px/);
              if (match) {
                const fontSizeFromStyle = parseFloat(match[1]);
                if (!isNaN(fontSizeFromStyle) && fontSizeFromStyle > 0) {
                  setFontSize(Math.round(fontSizeFromStyle));
                  break;
                }
              }
            }
            element = element.parentElement;
          }
        }
      } catch (e) {
        // queryCommandState might fail in some browsers, ignore
      }
    };

    // Update when default props change (annotation switched)
    const timer = setTimeout(updateFromEditor, 100);
    
    // Also listen for selection changes to update formatting buttons
    const handleSelectionChange = () => {
      updateFromEditor();
    };
    
    document.addEventListener('selectionchange', handleSelectionChange);
    
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, [defaultFontSize, defaultFont, defaultColor]);

  // Always show toolbar when PDF is loaded (no longer conditional on activeTool)

  // Get the active contentEditable element and preserve selection
  const getActiveEditor = (): { editor: HTMLElement | null; selection: Selection | null; savedRange: Range | null } => {
    const selection = window.getSelection();
    let savedRange: Range | null = null;
    let editor: HTMLElement | null = null;
    
    // First, try to use the saved selection if current selection is empty
    if (savedSelectionRef.current && (!selection || selection.rangeCount === 0 || selection.getRangeAt(0).collapsed)) {
      savedRange = savedSelectionRef.current.range.cloneRange();
      editor = savedSelectionRef.current.editor;
      return { editor, selection, savedRange };
    }
    
    // Save the selection range before it gets lost
    if (selection && selection.rangeCount > 0) {
      savedRange = selection.getRangeAt(0).cloneRange();
      
      // Find the editor that contains the selection
      const range = selection.getRangeAt(0);
      const commonAncestor = range.commonAncestorContainer;
      
      // Walk up the DOM tree to find the editor element
      let node: Node | null = commonAncestor.nodeType === Node.TEXT_NODE 
        ? commonAncestor.parentElement 
        : commonAncestor as Element;
      
      while (node && node !== document.body) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const element = node as HTMLElement;
          if (element.hasAttribute("contenteditable") && 
              element.getAttribute("data-rich-text-editor") === "true" &&
              element.isContentEditable) {
            editor = element;
            // Save the selection and editor for future use
            savedSelectionRef.current = { range: savedRange.cloneRange(), editor };
            break;
          }
        }
        node = node.parentElement;
      }
    }
    
    // Fallback: try to find editor from active element if no selection
    if (!editor) {
      const activeElement = document.activeElement as HTMLElement;
      if (activeElement && activeElement.hasAttribute("contenteditable") && 
          activeElement.getAttribute("data-rich-text-editor") === "true" &&
          activeElement.isContentEditable) {
        editor = activeElement;
      }
    }
    
    // Fallback: find any editor that is in edit mode (has contentEditable="true")
    if (!editor) {
      const allEditors = document.querySelectorAll('[data-rich-text-editor="true"][contenteditable="true"]');
      if (allEditors.length > 0) {
        editor = allEditors[0] as HTMLElement;
      }
    }
    
    return { editor, selection, savedRange };
  };
  
  // Save selection before input field gets focus
  const saveSelectionBeforeInputFocus = () => {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      // Save selection even if collapsed (cursor position) - this helps preserve cursor when adjusting font size
      const commonAncestor = range.commonAncestorContainer;
      let node: Node | null = commonAncestor.nodeType === Node.TEXT_NODE 
        ? commonAncestor.parentElement 
        : commonAncestor as Element;
      
      while (node && node !== document.body) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const element = node as HTMLElement;
          if (element.hasAttribute("contenteditable") && 
              element.getAttribute("data-rich-text-editor") === "true" &&
              element.isContentEditable) {
            savedSelectionRef.current = { range: range.cloneRange(), editor: element };
            break;
          }
        }
        node = node.parentElement;
      }
    } else {
      // If no selection, try to save cursor position from active editor
      const { editor } = getActiveEditor();
      if (editor) {
        // Create a collapsed range at the current cursor position
        const range = document.createRange();
        try {
          // Try to get cursor position
          const selection = window.getSelection();
          if (selection && selection.rangeCount > 0) {
            const selRange = selection.getRangeAt(0);
            range.setStart(selRange.startContainer, selRange.startOffset);
            range.collapse(true);
            savedSelectionRef.current = { range, editor };
          } else {
            // No selection, place at end
            range.selectNodeContents(editor);
            range.collapse(false);
            savedSelectionRef.current = { range, editor };
          }
        } catch (e) {
          // Fallback: place at end
          range.selectNodeContents(editor);
          range.collapse(false);
          savedSelectionRef.current = { range, editor };
        }
      }
    }
  };
  
  // Restore selection after formatting
  const restoreSelection = (editor: HTMLElement, range: Range | null) => {
    if (!range || !editor.contains(range.commonAncestorContainer)) {
      return;
    }
    
    // Focus the editor first
    editor.focus();
    
    // Restore the selection
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  };

  const handleFontSizeChange = (value: number[]) => {
    const newSize = value[0];
    setFontSize(newSize);
    // Only update annotation through callback - don't manipulate DOM directly
    onFontSizeChange(newSize);
    
    const { editor, savedRange } = getActiveEditor();
    if (!editor) {
      // If no editor is active, the change will apply to new annotations
      return;
    }
    
    // Don't focus the editor here - it will clear the selection
    // The savedRange should already be saved by onValueChangeStart
    // Only focus if we don't have a saved range (no selection to preserve)
    if (!savedRange || savedRange.collapsed) {
      editor.focus();
    }
    
    // Restore selection if we have a saved range
    if (savedRange && editor.contains(savedRange.commonAncestorContainer)) {
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(savedRange);
      }
      
      // Only apply font size to selected text if there's a selection (not just cursor)
      if (!savedRange.collapsed) {
        // Apply font size to selected text
        const range = savedRange;
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
        
        // Restore selection to the newly created span
        const newRange = document.createRange();
        newRange.selectNodeContents(span);
        const newSelection = window.getSelection();
        if (newSelection) {
          newSelection.removeAllRanges();
          newSelection.addRange(newRange);
        }
        
        // Trigger input event to save the updated HTML with font-size
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        // Just cursor position - update annotation fontSize which will update CSS
        // The CSS will handle the display for future typing
      }
    } else {
      // No selection: When in edit mode with no selection, the annotation's fontSize property
      // is already updated via onFontSizeChange callback, which updates the CSS style on the editor.
      // The CSS will handle the display, so we don't need to modify the HTML content.
      // This is consistent with how it works when NOT in edit mode.
    }
  };

  const handleFontChange = (font: string) => {
    setFontFamily(font);
    // Only update annotation through callback - don't manipulate DOM directly
    onFontChange(font);
    
    const { editor, savedRange } = getActiveEditor();
    if (!editor) {
      // If no editor is active, the change will apply to new annotations
      return;
    }
    
    // Focus the editor first (this might clear selection, so we restore it after)
    editor.focus();
    
    // Restore selection if we have a saved range
    if (savedRange && !savedRange.collapsed && editor.contains(savedRange.commonAncestorContainer)) {
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(savedRange);
      }
      
      // Apply font change using execCommand
      const success = document.execCommand("fontName", false, font);
      if (!success) {
        // Fallback: apply via CSS span
        const range = savedRange;
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
      
      // Restore selection after formatting to allow continuous formatting
      restoreSelection(editor, savedRange);
    } else if (savedRange && savedRange.collapsed) {
      // Collapsed selection (cursor) - apply to entire editor by setting base font
      // The annotation update will handle this, but we also apply it directly
      // to the editor for immediate visual feedback
      editor.style.fontFamily = font;
    } else {
      // No selection - apply to entire editor
      editor.style.fontFamily = font;
    }
    
    // Focus editor after a short delay (after dropdown closes)
    setTimeout(() => {
      if (document.activeElement?.tagName !== 'SELECT') {
        editor.focus();
      }
    }, 150);
  };

  const handleColorChange = (newColor: string) => {
    // Prevent popover from closing during color change
    allowColorPickerCloseRef.current = false;
    
    setColor(newColor);
    // Only update annotation through callback - don't manipulate DOM directly
    onColorChange(newColor);
    
    const { editor, savedRange } = getActiveEditor();
    if (!editor) {
      // If no editor is active, the change will apply to new annotations
      // Reset the flag after a delay
      setTimeout(() => {
        allowColorPickerCloseRef.current = true;
      }, 50);
      return;
    }
    
    // Don't focus the editor if popover is open - this causes it to close
    // But we still need to apply the color to selected text
    const shouldFocus = !showColorPicker;
    
    // Restore selection if we have a saved range
    if (savedRange && !savedRange.collapsed && editor.contains(savedRange.commonAncestorContainer)) {
      // Only focus if popover is closed
      if (shouldFocus) {
        editor.focus();
      }
      
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(savedRange);
      }
      
      // Apply color - use span method when popover is open (doesn't require focus)
      // Use execCommand when popover is closed (requires focus)
      if (shouldFocus) {
        const success = document.execCommand("foreColor", false, newColor);
        if (!success) {
          // Fallback: apply via CSS span
          const range = savedRange;
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
      } else {
        // When popover is open, use span method directly (doesn't require focus)
        const range = savedRange;
        
        // Check if the selection is entirely within a single span with a color style
        // If so, update that span's color instead of creating a new one
        let existingColorSpan: HTMLSpanElement | null = null;
        const startContainer = range.startContainer;
        
        // Walk up from start container to find a span with color
        let node: Node | null = startContainer;
        while (node && node !== editor) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node as HTMLElement;
            if (element.tagName === 'SPAN' && element.style.color) {
              // Check if the entire selection is within this span
              const spanRange = document.createRange();
              spanRange.selectNodeContents(element);
              if (range.compareBoundaryPoints(Range.START_TO_START, spanRange) >= 0 &&
                  range.compareBoundaryPoints(Range.END_TO_END, spanRange) <= 0) {
                existingColorSpan = element;
                break;
              }
            }
          }
          node = node.parentNode;
        }
        
        if (existingColorSpan) {
          // Update existing span's color
          existingColorSpan.style.color = newColor;
          
          // Restore selection to the existing span
          const newRange = document.createRange();
          newRange.selectNodeContents(existingColorSpan);
          const selection = window.getSelection();
          if (selection) {
            selection.removeAllRanges();
            selection.addRange(newRange);
            savedSelectionRef.current = { range: newRange.cloneRange(), editor };
          }
        } else {
          // Create new span and wrap the selection
          const span = document.createElement("span");
          span.style.color = newColor;
          try {
            range.surroundContents(span);
          } catch (e) {
            const contents = range.extractContents();
            span.appendChild(contents);
            range.insertNode(span);
          }
          
          // Immediately restore selection to the span we just created
          const newRange = document.createRange();
          newRange.selectNodeContents(span);
          const selection = window.getSelection();
          if (selection) {
            selection.removeAllRanges();
            selection.addRange(newRange);
            // Save this selection for the next color change
            savedSelectionRef.current = { range: newRange.cloneRange(), editor };
          }
        }
        
        // Trigger input event to save changes
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      }
      
      // Restore selection after formatting to allow continuous formatting
      if (shouldFocus) {
        restoreSelection(editor, savedRange);
        // Re-save the selection after restoration
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
          const currentRange = selection.getRangeAt(0);
          savedSelectionRef.current = { range: currentRange.cloneRange(), editor };
        }
      } else {
        // When popover is open, restore selection without focusing to keep popover open
        const selection = window.getSelection();
        if (selection && savedRange) {
          try {
            selection.removeAllRanges();
            selection.addRange(savedRange);
            // Re-save the selection after restoring it
            savedSelectionRef.current = { range: savedRange.cloneRange(), editor };
          } catch (e) {
            // Selection might be invalid, try to get current selection
            const currentSelection = window.getSelection();
            if (currentSelection && currentSelection.rangeCount > 0) {
              const currentRange = currentSelection.getRangeAt(0);
              savedSelectionRef.current = { range: currentRange.cloneRange(), editor };
            }
          }
        }
      }
    } else if (shouldFocus) {
      // No selection - just focus the editor if popover is closed
      editor.focus();
    }
    // If no selection and popover is open, the annotation update will handle the base color
    // Base color is handled by RichTextEditor from annotation prop
    
    // Reset the flag after color change is complete (but keep it false if popover is still open)
    setTimeout(() => {
      // Only reset if popover is still open - if it closed, that's fine
      if (showColorPicker) {
        // Keep it false to prevent accidental closes, but allow manual close via document listener
        // The document listener will set it to true when clicking outside
      }
    }, 100);
  };

  const handleFormat = (command: string, value?: string) => {
    const { editor, savedRange } = getActiveEditor();
    if (!editor) {
      // If no editor is active, the command will apply when user starts typing
      return;
    }
    
    // Focus the editor first (this might clear selection, so we restore it after)
    editor.focus();
    
    // Restore selection if we have a saved range
    if (savedRange && !savedRange.collapsed && editor.contains(savedRange.commonAncestorContainer)) {
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(savedRange);
      }
    }
    
    // Execute the command
    const success = document.execCommand(command, false, value);
    if (!success) {
      // Command execution failed, fallback method will be used
    }
    
    // Restore selection after formatting to allow continuous formatting
    if (savedRange && !savedRange.collapsed && editor.contains(savedRange.commonAncestorContainer)) {
      restoreSelection(editor, savedRange);
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
          // Save selection before select gets focus
          saveSelectionBeforeInputFocus();
          // Prevent the editor from stealing focus when clicking the select
          e.stopPropagation();
        }}
        onFocus={saveSelectionBeforeInputFocus}
      >
        <option value="Arial">Arial</option>
        <option value="Helvetica">Helvetica</option>
        <option value="Times New Roman">Times New Roman</option>
        <option value="Courier New">Courier New</option>
        <option value="Verdana">Verdana</option>
        <option value="Georgia">Georgia</option>
        <option value="Comic Sans MS">Comic Sans MS</option>
        <option value="Trebuchet MS">Trebuchet MS</option>
        <option value="Impact">Impact</option>
        <option value="Tahoma">Tahoma</option>
        <option value="Lucida Console">Lucida Console</option>
        <option value="Palatino">Palatino</option>
        <option value="Garamond">Garamond</option>
        <option value="Bookman">Bookman</option>
        <option value="Century Gothic">Century Gothic</option>
        <option value="Franklin Gothic Medium">Franklin Gothic Medium</option>
        <option value="MS Sans Serif">MS Sans Serif</option>
        <option value="MS Serif">MS Serif</option>
        <option value="Symbol">Symbol</option>
        <option value="Wingdings">Wingdings</option>
      </select>

      {/* Font Size */}
      <div 
        className="flex items-center gap-2 min-w-[180px]"
        onMouseDown={(e) => {
          // Save selection when mouse down on slider container (before any focus changes)
          saveSelectionBeforeInputFocus();
          e.stopPropagation();
        }}
      >
        <Type className="h-4 w-4 text-muted-foreground" />
        <Slider
          value={[fontSize]}
          onValueChange={handleFontSizeChange}
          min={8}
          max={72}
          step={1}
          className="flex-1"
        />
        <input
          type="number"
          value={fontSize}
          onFocus={saveSelectionBeforeInputFocus}
          onMouseEnter={saveSelectionBeforeInputFocus}
          onChange={(e) => {
            const newSize = parseInt(e.target.value) || 12;
            const clampedSize = Math.max(8, Math.min(72, newSize));
            handleFontSizeChange([clampedSize]);
          }}
          onBlur={(e) => {
            const newSize = parseInt(e.target.value) || 12;
            const clampedSize = Math.max(8, Math.min(72, newSize));
            if (clampedSize !== fontSize) {
              handleFontSizeChange([clampedSize]);
            }
            // Clear saved selection after applying change
            savedSelectionRef.current = null;
          }}
          className="w-12 h-8 px-1 text-sm border rounded bg-background text-center"
          min={8}
          max={72}
          onMouseDown={(e) => {
            // Save selection before input gets focus
            saveSelectionBeforeInputFocus();
            // Prevent the editor from stealing focus when clicking the input
            e.stopPropagation();
          }}
          onClick={() => {
            // Save selection when clicking (including spinner buttons)
            saveSelectionBeforeInputFocus();
          }}
        />
      </div>

      {/* Color Picker - only show in edit mode */}
      {isEditing && (
          <Popover 
          open={showColorPicker} 
          onOpenChange={(open) => {
            // When opening, allow it
            if (open) {
              setShowColorPicker(true);
              saveSelectionBeforeInputFocus();
              allowColorPickerCloseRef.current = true;
              return;
            }
            
            // When trying to close, COMPLETELY ignore Radix's attempt unless we explicitly allow it
            // Use requestAnimationFrame to ensure our state update happens after Radix's
            if (!allowColorPickerCloseRef.current) {
              // Force it to stay open - completely ignore Radix's close attempt
              requestAnimationFrame(() => {
                setShowColorPicker(true);
              });
              return;
            }
            
            // Only close if explicitly allowed
            setShowColorPicker(false);
          }}
          modal={false}
        >
          <PopoverTrigger asChild>
            <Button 
              ref={colorPickerTriggerRef}
              variant="outline" 
              size="icon" 
              className="h-8 w-8"
              onMouseDown={(e) => {
                // Save selection before popover opens
                saveSelectionBeforeInputFocus();
                // Prevent the editor from stealing focus when clicking the button
                e.stopPropagation();
                e.preventDefault();
              }}
            >
              <Palette className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent 
            ref={colorPickerContentRef}
            className="w-auto p-3"
            data-color-picker-popover="true"
            onOpenAutoFocus={(e) => e.preventDefault()}
            onInteractOutside={(e) => {
              // Prevent Radix from closing - we handle it manually with document listener
              const target = e.target as HTMLElement;
              const popoverContent = e.currentTarget as HTMLElement;
              
              // Check if the click is inside the popover content or its portal
              const isInsidePopover = popoverContent.contains(target) ||
                  target.closest('[data-formatting-toolbar]') || 
                  target.closest('[role="dialog"]') ||
                  target.closest('[data-radix-portal]') ||
                  target.closest('.react-colorful') ||
                  target.closest('[data-radix-popover-content]') ||
                  target.closest('[data-color-picker-popover]') ||
                  target.closest('[data-radix-slider-root]') ||
                  target.closest('[data-radix-slider-track]') ||
                  target.closest('[data-radix-slider-range]') ||
                  target.closest('[data-radix-slider-thumb]');
              
              if (isInsidePopover) {
                e.preventDefault();
                allowColorPickerCloseRef.current = false;
              }
            }}
            onPointerDownOutside={(e) => {
              // Prevent Radix from closing - we handle it manually with document listener
              const target = e.target as HTMLElement;
              const popoverContent = e.currentTarget as HTMLElement;
              
              const isInsidePopover = popoverContent.contains(target) ||
                  target.closest('.react-colorful') ||
                  target.closest('[data-radix-popover-content]') ||
                  target.closest('[data-color-picker-popover]') ||
                  target.closest('[data-radix-slider-root]') ||
                  target.closest('[data-formatting-toolbar]') ||
                  target.closest('[data-radix-portal]');
              
              if (isInsidePopover) {
                e.preventDefault();
                allowColorPickerCloseRef.current = false;
              }
            }}
            onFocusOutside={(e) => {
              // Prevent closing if focus moves to elements inside the popover
              const target = e.target as HTMLElement;
              const popoverContent = e.currentTarget as HTMLElement;
              
              if (popoverContent.contains(target) ||
                  target.closest('.react-colorful') ||
                  target.closest('[data-radix-popover-content]') ||
                  target.closest('[data-radix-slider-root]') ||
                  target.closest('[data-formatting-toolbar]') ||
                  target.closest('[data-radix-portal]')) {
                e.preventDefault();
                allowColorPickerCloseRef.current = false;
              }
            }}
            onEscapeKeyDown={() => {
              // Allow ESC to close the popover
              allowColorPickerCloseRef.current = true;
            }}
          >
            <div
              onMouseDown={(e) => {
                // Prevent all mouse events from closing the popover
                e.stopPropagation();
                e.preventDefault();
                allowColorPickerCloseRef.current = false;
                // Force keep open immediately
                setShowColorPicker(true);
              }}
              onMouseUp={(e) => {
                e.stopPropagation();
                e.preventDefault();
                allowColorPickerCloseRef.current = false;
                setShowColorPicker(true);
              }}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                allowColorPickerCloseRef.current = false;
                setShowColorPicker(true);
              }}
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                allowColorPickerCloseRef.current = false;
                setShowColorPicker(true);
              }}
              onPointerUp={(e) => {
                e.stopPropagation();
                e.preventDefault();
                allowColorPickerCloseRef.current = false;
                setShowColorPicker(true);
              }}
            >
              {/* Preset Color Grid */}
              <div className="grid grid-cols-4 gap-1.5 w-36">
                {presetColors.map((preset) => {
                  const isSelected = isPresetColorSelected(preset);
                  const displayColor = rgbToRgba(preset.r, preset.g, preset.b);
                  return (
                    <button
                      key={preset.name}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        // Save selection before color change to ensure it's fresh
                        saveSelectionBeforeInputFocus();
                        const rgbaColor = rgbToRgba(preset.r, preset.g, preset.b);
                        handleColorChange(rgbaColor);
                      }}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        // Save selection on mouse down as well to catch it early
                        saveSelectionBeforeInputFocus();
                      }}
                      className={`
                        w-7 h-7 rounded border transition-all
                        ${isSelected 
                          ? 'border-primary ring-1 ring-primary' 
                          : 'border-border hover:border-primary/50'
                        }
                      `}
                      style={{
                        backgroundColor: displayColor,
                      }}
                      title={preset.name}
                    />
                  );
                })}
              </div>
            </div>
          </PopoverContent>
        </Popover>
      )}

      <div className="h-6 w-px bg-border" />

      {/* Text Style Buttons */}
      <Button
        variant={isBold ? "default" : "outline"}
        size="icon"
        className="h-8 w-8"
        onClick={() => {
          handleFormat("bold");
          // Update state immediately for visual feedback
          setIsBold(!isBold);
        }}
        title="Bold (Ctrl+B)"
      >
        <Bold className="h-4 w-4" />
      </Button>
      <Button
        variant={isItalic ? "default" : "outline"}
        size="icon"
        className="h-8 w-8"
        onClick={() => {
          handleFormat("italic");
          // Update state immediately for visual feedback
          setIsItalic(!isItalic);
        }}
        title="Italic (Ctrl+I)"
      >
        <Italic className="h-4 w-4" />
      </Button>
      <Button
        variant={isUnderline ? "default" : "outline"}
        size="icon"
        className="h-8 w-8"
        onClick={() => {
          handleFormat("underline");
          // Update state immediately for visual feedback
          setIsUnderline(!isUnderline);
        }}
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

      {/* Delete Button - only show when something is selected */}
      {onDelete && hasSelection && (
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete Annotation"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}

      {/* Background controls - only show in edit mode */}
      {isEditing && (
        <>
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
            <Popover 
              open={showBackgroundColorPicker} 
              onOpenChange={(open) => {
                setShowBackgroundColorPicker(open);
                // Save selection when popover opens (in case it opens via keyboard or programmatically)
                if (open) {
                  saveSelectionBeforeInputFocus();
                }
              }}
              modal={false}
            >
              <PopoverTrigger asChild>
                <Button 
                  variant="outline" 
                  size="icon" 
                  className="h-8 w-8"
                  onMouseDown={(e) => {
                    // Save selection before popover opens
                    saveSelectionBeforeInputFocus();
                    // Prevent the editor from stealing focus when clicking the button
                    e.stopPropagation();
                    e.preventDefault();
                  }}
                >
                  <div
                    className="h-4 w-4 rounded border border-border"
                    style={{ 
                      backgroundColor: (() => {
                        const rgb = getRgbFromColor(backgroundColor);
                        return rgbToRgba(rgb.r, rgb.g, rgb.b);
                      })(),
                    }}
                  />
                </Button>
              </PopoverTrigger>
              <PopoverContent 
                className="w-auto p-3"
                onOpenAutoFocus={(e) => e.preventDefault()}
                onInteractOutside={(e) => {
                  // Prevent closing if clicking anywhere inside the popover or toolbar
                  const target = e.target as HTMLElement;
                  const popoverContent = e.currentTarget as HTMLElement;
                  
                  // Check if the click is inside the popover content or its portal
                  if (popoverContent.contains(target) ||
                      target.closest('[data-formatting-toolbar]') || 
                      target.closest('[role="dialog"]') ||
                      target.closest('[data-radix-portal]') ||
                      target.closest('.react-colorful') ||
                      target.closest('[data-radix-popover-content]') ||
                      target.closest('[data-radix-slider-root]') ||
                      target.closest('[data-radix-slider-track]') ||
                      target.closest('[data-radix-slider-range]') ||
                      target.closest('[data-radix-slider-thumb]')) {
                    e.preventDefault();
                  }
                }}
                onPointerDownOutside={(e) => {
                  // Prevent closing if clicking anywhere inside the popover or toolbar
                  const target = e.target as HTMLElement;
                  const popoverContent = e.currentTarget as HTMLElement;
                  
                  if (popoverContent.contains(target) ||
                      target.closest('.react-colorful') ||
                      target.closest('[data-radix-popover-content]') ||
                      target.closest('[data-radix-slider-root]') ||
                      target.closest('[data-formatting-toolbar]') ||
                      target.closest('[data-radix-portal]')) {
                    e.preventDefault();
                  }
                }}
                onFocusOutside={(e) => {
                  // Prevent closing if focus moves to elements inside the popover
                  const target = e.target as HTMLElement;
                  const popoverContent = e.currentTarget as HTMLElement;
                  
                  if (popoverContent.contains(target) ||
                      target.closest('.react-colorful') ||
                      target.closest('[data-radix-popover-content]') ||
                      target.closest('[data-radix-slider-root]') ||
                      target.closest('[data-formatting-toolbar]') ||
                      target.closest('[data-radix-portal]')) {
                    e.preventDefault();
                  }
                }}
                onEscapeKeyDown={() => {
                  // Allow ESC to close the popover
                  // Don't prevent default
                }}
              >
                {/* Preset Color Grid */}
                <div className="grid grid-cols-4 gap-1.5 w-36">
                  {presetColors.map((preset) => {
                    const isSelected = (() => {
                      const currentRgb = getRgbFromColor(backgroundColor);
                      return currentRgb.r === preset.r && currentRgb.g === preset.g && currentRgb.b === preset.b;
                    })();
                    const displayColor = rgbToRgba(preset.r, preset.g, preset.b);
                    return (
                      <button
                        key={preset.name}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          const rgbaColor = rgbToRgba(preset.r, preset.g, preset.b);
                          setBackgroundColor(rgbaColor);
                          onBackgroundColorChange?.(rgbaColor);
                        }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                        }}
                        className={`
                          w-7 h-7 rounded border transition-all
                          ${isSelected 
                            ? 'border-primary ring-1 ring-primary' 
                            : 'border-border hover:border-primary/50'
                          }
                        `}
                        style={{
                          backgroundColor: displayColor,
                        }}
                        title={preset.name}
                      />
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>
          )}
        </>
      )}
    </div>
  );
}







