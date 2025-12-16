/**
 * Rich Text Editor Component
 * 
 * A contentEditable-based rich text editor with formatting support.
 */

import { useRef, useEffect, useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import type { Annotation } from "@/core/pdf/PDFEditor";
import { useUIStore } from "@/shared/stores/uiStore";
// Circular rotation handle component
const RotationHandle = ({ 
  size, 
  className,
  isHovered,
  isActive
}: { 
  size: number; 
  className?: string;
  isHovered?: boolean;
  isActive?: boolean;
}) => (
  <div
    className={cn(
      "rounded-full border-2 transition-all pointer-events-none",
      isActive 
        ? "bg-blue-500 border-blue-600" 
        : isHovered 
        ? "bg-blue-400 border-blue-500" 
        : "bg-white border-blue-400",
      className
    )}
    style={{
      width: `${size}px`,
      height: `${size}px`,
      boxShadow: isHovered || isActive ? "0 2px 8px rgba(0,0,0,0.2)" : "0 1px 4px rgba(0,0,0,0.1)",
    }}
  />
);

interface RichTextEditorProps {
  annotation: Annotation;
  content: string;
  onChange: (html: string) => void;
  onBlur: () => void;
  style?: React.CSSProperties;
  className?: string;
  scale: number;
  onResize?: (width: number, height: number) => void;
  onResizeEnd?: () => void;
  onRotate?: (angle: number) => void;
  onRotateEnd?: () => void;
  onMove?: (x: number, y: number) => void;
  onDragEnd?: () => void;
  onDuplicate?: (e: React.MouseEvent) => void; // Called when CTRL+drag is detected
  isEditing?: boolean;
  onEditModeChange?: (editing: boolean) => void;
  isSelected?: boolean;
  isHovered?: boolean; // Whether the annotation is being hovered (for visual feedback)
  pageRotation?: number; // Page rotation in degrees (0, 90, 180, 270)
  activeTool?: string; // Current active tool - prevents dragging when pan tool is active
  isSpacePressed?: boolean; // Whether space bar is pressed - prevents dragging when space is held
}

export function RichTextEditor({
  annotation,
  content,
  onChange,
  onBlur,
  style,
  className,
  scale,
  onResize,
  onResizeEnd,
  onRotate,
  onRotateEnd,
  onMove,
  onDragEnd,
  onDuplicate,
  isEditing = false,
  onEditModeChange,
  isSelected = false,
  isHovered = false,
  pageRotation = 0,
  activeTool,
  isSpacePressed = false,
}: RichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [resizeCorner, setResizeCorner] = useState<string | null>(null);
  const [rotationStart, setRotationStart] = useState({ x: 0, y: 0, angle: 0, centerX: 0, centerY: 0 });
  const dragStartRef = useRef({ x: 0, y: 0 }); // Use ref for synchronous updates during drag
  const [isRotationHandleHovered, setIsRotationHandleHovered] = useState(false);
  const { zoomLevel } = useUIStore();
  // Calculate initial size based on font size if not provided
  const calculateInitialSize = (fontSize: number) => {
    // Width: approximately 15-20 characters worth (font size * 0.6 per char, so ~15 chars = fontSize * 9)
    const width = fontSize * 9;
    // Height: approximately 1.5 line heights (font size * 1.5)
    const height = fontSize * 1.5;
    return { width, height };
  };

  const defaultFontSize = annotation.fontSize || 12;
  const defaultSize = calculateInitialSize(defaultFontSize);
  
  const [size, setSize] = useState({
    width: annotation.width || (isEditing ? defaultSize.width * 0.5 : defaultSize.width),
    height: annotation.height || (isEditing ? defaultSize.height : defaultSize.height),
  });
  const [rotation, setRotation] = useState(annotation.rotation || 0);
  const [hasBackground, setHasBackground] = useState(annotation.hasBackground !== undefined ? annotation.hasBackground : true);
  const [backgroundColor, setBackgroundColor] = useState(annotation.backgroundColor || "rgba(255, 255, 255, 0)");
  // Use annotation.fontSize directly instead of state to ensure it updates immediately
  const fontSize = annotation.fontSize || 12;
  const initialSizeRef = useRef({ 
    width: annotation.width || defaultSize.width, 
    height: annotation.height || defaultSize.height 
  });
  const initialFontSizeRef = useRef(defaultFontSize);
  const sizeRef = useRef(size);
  const resizeStartRef = useRef({ x: 0, y: 0 });
  const initialResizeSizeRef = useRef({ width: 0, height: 0 });
  const initialResizeCenterRef = useRef({ x: 0, y: 0 });

  // Keep sizeRef in sync with size state
  useEffect(() => {
    sizeRef.current = size;
  }, [size]);

  // Sync size and background with annotation
  useEffect(() => {
    const currentFontSize = annotation.fontSize || 12;
    const calculatedSize = calculateInitialSize(currentFontSize);
    
    if (annotation.width && annotation.width !== size.width) {
      setSize(prev => ({ ...prev, width: annotation.width || calculatedSize.width }));
      initialSizeRef.current.width = annotation.width || calculatedSize.width;
    }
    if (annotation.height && annotation.height !== size.height) {
      setSize(prev => ({ ...prev, height: annotation.height || calculatedSize.height }));
      initialSizeRef.current.height = annotation.height || calculatedSize.height;
    }
    // Update initialFontSizeRef when annotation fontSize changes
    if (annotation.fontSize && annotation.fontSize !== initialFontSizeRef.current) {
      initialFontSizeRef.current = annotation.fontSize;
    }
    if (annotation.hasBackground !== undefined && annotation.hasBackground !== hasBackground) {
      setHasBackground(annotation.hasBackground);
    }
    // Always sync backgroundColor from annotation prop
    // If annotation has backgroundColor, use it; otherwise keep current state or use default
    if (annotation.backgroundColor !== undefined) {
      // Annotation has explicit backgroundColor - always sync it
      if (annotation.backgroundColor !== backgroundColor) {
        setBackgroundColor(annotation.backgroundColor);
      }
    } else if (annotation.hasBackground && !annotation.backgroundColor) {
      // hasBackground is true but no backgroundColor in annotation - use default
      if (backgroundColor !== "rgba(255, 255, 255, 0)") {
        setBackgroundColor("rgba(255, 255, 255, 0)");
      }
    }
  }, [annotation.width, annotation.height, annotation.fontSize, annotation.hasBackground, annotation.backgroundColor, size.width, size.height, hasBackground, backgroundColor]);

  // Ensure styles are applied correctly - set styles directly to ensure they're not overridden
  // Use annotation prop directly to ensure we always have the latest values
  useEffect(() => {
    if (!editorRef.current) return;
    
    // Apply color and background color directly - use annotation prop values directly
    const currentColor = annotation.color || "rgba(0, 0, 0, 1)";
    // Use annotation.backgroundColor if available, otherwise use state, otherwise use default
    const annotationBgColor = annotation.backgroundColor !== undefined 
      ? annotation.backgroundColor 
      : (hasBackground ? (backgroundColor || "rgba(255, 255, 255, 0)") : "rgba(255, 255, 255, 0)");
    const currentBackgroundColor = hasBackground ? annotationBgColor : "rgba(255, 255, 255, 0)";
    
    // Set styles directly with !important to ensure they override any CSS classes
    editorRef.current.style.setProperty('color', currentColor, 'important');
    editorRef.current.style.setProperty('background-color', currentBackgroundColor, 'important');
  }, [annotation.color, annotation.backgroundColor, annotation.hasBackground, hasBackground, backgroundColor]);
  
  // Track previous content to prevent unnecessary updates
  const previousContentRef = useRef<string>("");
  
  // Auto-fit to content when in edit mode - only if autoFit is enabled
  useEffect(() => {
    if (!isEditing || !editorRef.current || !annotation.autoFit) return;
    
    const updateSize = () => {
      if (editorRef.current) {
        const currentContent = editorRef.current.innerHTML;
        
        // Only update if content actually changed
        if (currentContent === previousContentRef.current) {
          return;
        }
        
        previousContentRef.current = currentContent;
        
        // Measure text width by creating a temporary element with same styles
        const measureTextWidth = (): number => {
          if (!editorRef.current) return fontSize * 9;
          
          // Create a temporary element with the same styles
          const temp = document.createElement('div');
          temp.style.position = 'absolute';
          temp.style.visibility = 'hidden';
          temp.style.whiteSpace = 'nowrap'; // Don't wrap for width measurement
          temp.style.fontSize = `${fontSize * scale}px`;
          temp.style.fontFamily = annotation.fontFamily || "Arial";
          temp.style.padding = editorRef.current.style.padding || '0';
          temp.innerHTML = currentContent || 'M'; // Use 'M' as minimum width if empty
          
          document.body.appendChild(temp);
          const width = temp.offsetWidth;
          document.body.removeChild(temp);
          
          // Convert from screen pixels to PDF coordinates and add padding
          const padding = fontSize * 2; // Padding proportional to font size
          return Math.max(fontSize * 3, (width / scale) + padding);
        };
        
        // Only auto-fit if autoFit is enabled
        if (annotation.autoFit) {
          // Measure actual text width
          const textContent = currentContent.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
          let newWidth = size.width;
          
          if (textContent) {
            newWidth = measureTextWidth();
          } else {
            // Empty text: use default width based on font size
            newWidth = fontSize * 9;
          }
          
          // In auto-fit mode, text doesn't wrap, so height is just one line
          // Measure the actual height needed (single line height)
          const originalWidth = editorRef.current.style.width;
          const originalMaxWidth = editorRef.current.style.maxWidth;
          const originalWhiteSpace = editorRef.current.style.whiteSpace;
          // Set width and no-wrap to measure single line height
          editorRef.current.style.width = `${newWidth * scale}px`;
          editorRef.current.style.maxWidth = "none";
          editorRef.current.style.whiteSpace = "nowrap";
          const contentHeight = editorRef.current.scrollHeight;
          editorRef.current.style.width = originalWidth;
          editorRef.current.style.maxWidth = originalMaxWidth;
          editorRef.current.style.whiteSpace = originalWhiteSpace;
          
          // Update height to fit content (single line height with padding)
          const padding = fontSize * 0.5; // Smaller padding for better fit
          const newHeight = Math.max(fontSize * 1.2, (contentHeight / scale) + padding);
          
          // Update both width and height
          setSize(prev => {
            const widthChanged = Math.abs(newWidth - prev.width) > 1;
            const heightChanged = Math.abs(newHeight - prev.height) > 1;
            
            if (widthChanged || heightChanged) {
              return { width: newWidth, height: newHeight };
            }
            return prev;
          });
          
          if (onResize && (Math.abs(newWidth - size.width) > 1 || Math.abs(newHeight - size.height) > 1)) {
            onResize(newWidth, newHeight);
          }
        } else {
          // Fixed width mode (drag mode): only adjust height, keep width fixed
          const originalWidth = editorRef.current.style.width;
          const originalMaxWidth = editorRef.current.style.maxWidth;
          // Use current fixed width
          editorRef.current.style.width = `${size.width * scale}px`;
          editorRef.current.style.maxWidth = `${size.width * scale}px`;
          const contentHeight = editorRef.current.scrollHeight;
          editorRef.current.style.width = originalWidth;
          editorRef.current.style.maxWidth = originalMaxWidth;
          
          // Update only height to fit content
          const padding = fontSize * 0.5;
          const newHeight = Math.max(fontSize * 1.2, (contentHeight / scale) + padding);
          
          setSize(prev => {
            const heightChanged = Math.abs(newHeight - prev.height) > 1;
            if (heightChanged) {
              return { width: prev.width, height: newHeight };
            }
            return prev;
          });
          
          if (onResize && Math.abs(newHeight - size.height) > 1) {
            onResize(size.width, newHeight);
          }
        }
      }
    };
    
    // Update size on input - debounced
    let timeoutId: NodeJS.Timeout;
    const handleInputForSize = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        requestAnimationFrame(updateSize);
      }, 50); // Debounce by 50ms
    };
    
    if (editorRef.current) {
      editorRef.current.addEventListener('input', handleInputForSize);
      // Initial size update
      setTimeout(updateSize, 0);
      
      return () => {
        clearTimeout(timeoutId);
        if (editorRef.current) {
          editorRef.current.removeEventListener('input', handleInputForSize);
        }
      };
    }
  }, [isEditing, scale, onResize, annotation.fontSize, annotation.fontFamily]);

  // Handle keyboard shortcuts and ESC key
  useEffect(() => {
    // Only handle shortcuts when text box is selected or in edit mode
    if (!isEditing && !isSelected) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Check if the event is related to this editor
      const isInEditor = editorRef.current && (
        document.activeElement === editorRef.current ||
        editorRef.current.contains(document.activeElement as Node) ||
        editorRef.current.contains(e.target as Node)
      );
      
      // Check if there's a text selection in this editor
      const selection = window.getSelection();
      const hasSelectionInEditor = selection && selection.rangeCount > 0 && 
        editorRef.current && editorRef.current.contains(selection.getRangeAt(0).commonAncestorContainer);
      
      // Only handle shortcuts if:
      // 1. Editor is focused, OR
      // 2. Text box is selected (isSelected) and shortcut is pressed, OR
      // 3. There's a text selection in this editor
      if (!isInEditor && !isSelected && !hasSelectionInEditor) {
        return;
      }
      
      // Don't handle shortcuts when typing in other inputs (unless it's our editor)
      if (!isInEditor && (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable && e.target !== editorRef.current)
      )) {
        return;
      }

      // ESC key to exit edit mode
      if (e.key === "Escape" && isEditing) {
        e.preventDefault();
        e.stopPropagation();
        if (onEditModeChange) {
          onEditModeChange(false);
        }
        editorRef.current?.blur();
        return;
      }

      // Formatting shortcuts (only when text box is selected or in edit mode or text is selected)
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        // Focus editor if not already focused but text box is selected
        if (!isInEditor && editorRef.current && (isSelected || hasSelectionInEditor)) {
          editorRef.current.focus();
          // If there was a selection, restore it
          if (hasSelectionInEditor && selection && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            selection.removeAllRanges();
            selection.addRange(range);
          }
        }

        switch (e.key.toLowerCase()) {
          case "a": // Select All
            // Only select all when in edit mode
            if (isEditing && editorRef.current) {
              e.preventDefault();
              e.stopPropagation();
              // Select all text in the editor
              const range = document.createRange();
              range.selectNodeContents(editorRef.current);
              const sel = window.getSelection();
              if (sel) {
                sel.removeAllRanges();
                sel.addRange(range);
              }
            }
            break;
          case "b": // Bold
            e.preventDefault();
            e.stopPropagation();
            if (editorRef.current) {
              document.execCommand("bold", false);
            }
            break;
          case "i": // Italic
            e.preventDefault();
            e.stopPropagation();
            if (editorRef.current) {
              document.execCommand("italic", false);
            }
            break;
          case "u": // Underline
            e.preventDefault();
            e.stopPropagation();
            if (editorRef.current) {
              document.execCommand("underline", false);
            }
            break;
          case "l": // Align Left
            e.preventDefault();
            e.stopPropagation();
            if (editorRef.current) {
              document.execCommand("justifyLeft", false);
            }
            break;
          case "r": // Align Right
            e.preventDefault();
            e.stopPropagation();
            if (editorRef.current) {
              document.execCommand("justifyRight", false);
            }
            break;
          case "m": // Center Align
            e.preventDefault();
            e.stopPropagation();
            if (editorRef.current) {
              document.execCommand("justifyCenter", false);
            }
            break;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isEditing, isSelected, onEditModeChange]);

  // Initialize content and focus when entering edit mode
  useEffect(() => {
    if (editorRef.current) {
      if (isEditing) {
        // When entering edit mode, set content if different
        if (content !== editorRef.current.innerHTML) {
          editorRef.current.innerHTML = content || "";
        }
        // Focus but preserve existing cursor position or place at end if no selection
        setTimeout(() => {
          editorRef.current?.focus();
          const selection = window.getSelection();
          // Only move cursor to end if there's no existing selection
          if (!selection || selection.rangeCount === 0 || selection.getRangeAt(0).collapsed) {
            const range = document.createRange();
            range.selectNodeContents(editorRef.current!);
            range.collapse(false);
            if (selection) {
              selection.removeAllRanges();
              selection.addRange(range);
            }
          }
        }, 0);
      } else {
        // When not editing, always ensure content is set for display
        // Use innerHTML to ensure content is visible
        const currentContent = editorRef.current.innerHTML;
        if (currentContent !== content) {
          editorRef.current.innerHTML = content || "";
        }
      }
    }
  }, [isEditing, content, annotation.id]);

  // Handle content changes
  const handleInput = useCallback(() => {
    if (editorRef.current) {
      const html = editorRef.current.innerHTML;
      onChange(html);
    }
  }, [onChange]);

  // Handle paste to strip formatting if needed
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, text);
  }, []);

  // Handle drag on entire box or handle - allow double-click to work
  const handleDragMouseDown = useCallback((e: React.MouseEvent) => {
    if (isEditing) return; // Don't drag when in edit mode
    if (activeTool === "pan" || isSpacePressed) {
      // Don't drag when pan tool is active or space bar is pressed (space = pan shortcut)
      e.stopPropagation();
      return;
    }
    
    const target = e.target as HTMLElement;
    
    // Don't start drag if clicking on the editor content area - allow double-click to work
    if (target.closest('[data-rich-text-editor]') || target === editorRef.current) {
      return; // Let the double-click handler on the editor div handle it
    }
    
    // Don't start drag if clicking on corner handles, rotation handle, or buttons
    if (
      target.closest('[data-corner-handle]') ||
      target.closest('[data-resize-handle]') ||
      target.closest('[data-rotation-handle]') ||
      target.closest('[data-drag-handle]') ||
      target.closest('button') ||
      target.closest('input[type="color"]')
    ) {
      // If clicking on drag handle, still allow drag
      if (target.closest('[data-drag-handle]')) {
        e.preventDefault();
        e.stopPropagation();
        // Check for CTRL key for duplication
        if (e.ctrlKey || e.metaKey) {
          if (onDuplicate) {
            onDuplicate(e);
          }
        } else {
          setIsDragging(true);
          dragStartRef.current = { x: e.clientX, y: e.clientY };
        }
      }
      // If clicking on rotation handle, handle rotation
      if (target.closest('[data-rotation-handle]')) {
        e.preventDefault();
        e.stopPropagation();
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        setIsRotating(true);
        setRotationStart({ 
          x: e.clientX, 
          y: e.clientY, 
          angle: rotation,
          centerX,
          centerY
        });
      }
      return;
    }
    
    // Check for CTRL key for duplication
    if (e.ctrlKey || e.metaKey) {
      if (onDuplicate) {
        onDuplicate(e);
      }
      return; // Don't start normal drag when duplicating
    }
    
    // Don't prevent default or stop propagation - allow double-click to work
    // Only track the mouse position for potential drag
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
  }, [isEditing, onDuplicate, rotation, activeTool, isSpacePressed]);

  // Handle drag to move
  useEffect(() => {
    if (!isDragging || isEditing || activeTool === "pan" || isSpacePressed) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Calculate delta in screen coordinates (pixels)
      // Use the current dragStartRef position to calculate incremental delta (ref updates synchronously)
      const screenDeltaX = e.clientX - dragStartRef.current.x;
      const screenDeltaY = e.clientY - dragStartRef.current.y;
      
      // Only move if we've actually dragged (moved more than a few pixels)
      const moveDistance = Math.sqrt(
        Math.pow(screenDeltaX, 2) + Math.pow(screenDeltaY, 2)
      );
      
      if (moveDistance > 3) {
        e.preventDefault();
        
        // Convert screen pixel delta to PDF coordinate delta
        // With 1:1 mapping (BASE_SCALE = 1.0, no devicePixelRatio scaling):
        // The text box is inside a container with CSS transform: scale(zoomLevel)
        // So: pdfDelta = screenDelta / zoomLevel
        // Y is negated because pdfToCanvas flips Y (PDF Y=0 at bottom, canvas Y=0 at top)
        const pdfDeltaX = screenDeltaX / zoomLevel;
        const pdfDeltaY = -screenDeltaY / zoomLevel; // Negate Y because pdfToCanvas flips Y
        
        if (onMove) {
          onMove(pdfDeltaX, pdfDeltaY);
        }
        
        // Update dragStartRef to current mouse position for next incremental delta calculation (synchronous update)
        dragStartRef.current = { x: e.clientX, y: e.clientY };
      }
    };

    const handleMouseUp = () => {
      const wasDragging = isDragging;
      setIsDragging(false);
      // Notify parent when drag ends
      if (wasDragging && onDragEnd) {
        onDragEnd();
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, isEditing, scale, onMove, onDragEnd, activeTool, isSpacePressed]);

  // Prevent blur when clicking outside (like on toolbar)
  const handleBlur = useCallback((e: React.FocusEvent) => {
    // Check if the new focus target is part of the formatting toolbar or a button
    const relatedTarget = e.relatedTarget as HTMLElement;
    if (relatedTarget) {
      // For select elements, don't refocus - let the dropdown work
      if (relatedTarget.closest('select')) {
        // Don't blur, and don't refocus - allow the select to maintain focus
        return;
      }
      // Don't blur if clicking on toolbar elements
      if (
        relatedTarget.closest('[data-formatting-toolbar]') ||
        relatedTarget.closest('button') ||
        relatedTarget.closest('input[type="color"]')
      ) {
        // Keep focus on editor
        setTimeout(() => {
          editorRef.current?.focus();
        }, 0);
        return;
      }
    }
    onBlur();
  }, [onBlur]);

  // Handle corner interaction - only resize now
  const handleCornerMouseDown = useCallback((e: React.MouseEvent, corner: string) => {
    if (activeTool === "pan" || isSpacePressed) {
      // Don't resize when pan tool is active or space bar is pressed (space = pan shortcut)
      e.stopPropagation();
      return;
    }
    
    // Exit edit mode when starting to resize
    if (isEditing && onEditModeChange) {
      onEditModeChange(false);
    }
    
    e.preventDefault();
    e.stopPropagation();
    if (e.nativeEvent && 'stopImmediatePropagation' in e.nativeEvent) {
      e.nativeEvent.stopImmediatePropagation();
    }
    
    if (!containerRef.current) return;
    
    // Capture initial values synchronously for resize
    const rect = containerRef.current.getBoundingClientRect();
    initialResizeCenterRef.current = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
    initialResizeSizeRef.current = { width: sizeRef.current.width, height: sizeRef.current.height };
    resizeStartRef.current = { x: e.clientX, y: e.clientY };
    setIsResizing(true);
    setResizeCorner(corner);
  }, [isEditing, activeTool, isSpacePressed]);
  
  // Handle resize - smooth updates using requestAnimationFrame
  useEffect(() => {
    if (!isResizing || !resizeCorner || !containerRef.current || activeTool === "pan" || isSpacePressed) return;

    let rafId: number;
    let pendingUpdate: { width: number; height: number } | null = null;

    const handleMouseMove = (e: MouseEvent) => {
      // Use the initial center position (stored when resize started)
      const centerX = initialResizeCenterRef.current.x;
      const centerY = initialResizeCenterRef.current.y;

      // Transform current mouse position to container's local (unrotated) coordinate system
      const rad = -rotation * (Math.PI / 180); // Negative because CSS rotation is clockwise
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      
      // Transform current mouse position (relative to center)
      const currentRelX = e.clientX - centerX;
      const currentRelY = e.clientY - centerY;
      const currentLocalX = currentRelX * cos - currentRelY * sin;
      const currentLocalY = currentRelX * sin + currentRelY * cos;
      
      // Transform initial mouse position (relative to center)
      const initialRelX = resizeStartRef.current.x - centerX;
      const initialRelY = resizeStartRef.current.y - centerY;
      const initialLocalX = initialRelX * cos - initialRelY * sin;
      const initialLocalY = initialRelX * sin + initialRelY * cos;
      
      // Calculate delta in local coordinates, then convert to PDF coordinates
      const deltaX = (currentLocalX - initialLocalX) / scale;
      const deltaY = (currentLocalY - initialLocalY) / scale;
      
      // Calculate new size based on initial size and delta
      let newWidth = initialResizeSizeRef.current.width;
      let newHeight = initialResizeSizeRef.current.height;
      
      // Calculate resize based on corner
      switch (resizeCorner) {
        case "nw": // Top-left
          newWidth = Math.max(100, initialResizeSizeRef.current.width - deltaX);
          newHeight = Math.max(50, initialResizeSizeRef.current.height - deltaY);
          break;
        case "ne": // Top-right
          newWidth = Math.max(100, initialResizeSizeRef.current.width + deltaX);
          newHeight = Math.max(50, initialResizeSizeRef.current.height - deltaY);
          break;
        case "sw": // Bottom-left
          newWidth = Math.max(100, initialResizeSizeRef.current.width - deltaX);
          newHeight = Math.max(50, initialResizeSizeRef.current.height + deltaY);
          break;
        case "se": // Bottom-right
          newWidth = Math.max(100, initialResizeSizeRef.current.width + deltaX);
          newHeight = Math.max(50, initialResizeSizeRef.current.height + deltaY);
          break;
      }
      
      // Store pending update
      pendingUpdate = { width: newWidth, height: newHeight };

      // Cancel any pending frame and schedule update
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (pendingUpdate) {
          // Update state
          setSize(pendingUpdate);
          sizeRef.current = pendingUpdate;
          
          // Callback for parent
          if (onResize) {
            onResize(pendingUpdate.width, pendingUpdate.height);
          }
          
          pendingUpdate = null;
        }
      });
    };

    const handleMouseUp = () => {
      const wasResizing = isResizing;
      cancelAnimationFrame(rafId);
      setIsResizing(false);
      setResizeCorner(null);
      // Notify parent when resize ends
      if (wasResizing && onResizeEnd) {
        onResizeEnd();
      }
      // Update initial refs for next resize
      initialSizeRef.current = { width: sizeRef.current.width, height: sizeRef.current.height };
    };

    window.addEventListener("mousemove", handleMouseMove, { passive: true });
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, resizeCorner, scale, onResize, rotation, activeTool, isSpacePressed]);

  // Handle rotation - up/down movement
  useEffect(() => {
    if (!isRotating || activeTool === "pan" || isSpacePressed) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Calculate angle from center to current mouse position
      const dx = e.clientX - rotationStart.centerX;
      const dy = e.clientY - rotationStart.centerY;
      const currentAngle = Math.atan2(dy, dx) * (180 / Math.PI);
      
      // Calculate angle from center to initial mouse position
      const initialDx = rotationStart.x - rotationStart.centerX;
      const initialDy = rotationStart.y - rotationStart.centerY;
      const initialAngle = Math.atan2(initialDy, initialDx) * (180 / Math.PI);
      
      // Calculate rotation delta (difference in angles)
      let rotationDelta = currentAngle - initialAngle;
      
      // Normalize to -180 to 180 range
      if (rotationDelta > 180) rotationDelta -= 360;
      if (rotationDelta < -180) rotationDelta += 360;
      
      // Apply rotation
      const newRotation = (rotationStart.angle + rotationDelta) % 360;
      
      setRotation(newRotation);
      
      if (onRotate) {
        onRotate(newRotation);
      }
    };

    const handleMouseUp = () => {
      const wasRotating = isRotating;
      setIsRotating(false);
      // Notify parent when rotation ends
      if (wasRotating && onRotateEnd) {
        onRotateEnd();
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isRotating, rotationStart, onRotate, onRotateEnd, activeTool, isSpacePressed]);

  const handleSize = 8 * scale;
  const rotationHandleSize = 12 * scale; // Size of the rotation handle circle
  const rotationHandleOffset = rotationHandleSize * 1.5; // Distance above the text box
  const [hoveredCorner, setHoveredCorner] = useState<string | null>(null);

  // Calculate total rotation: annotation rotation (relative to page) + page rotation
  const totalRotation = rotation + pageRotation;

  return (
    <div
      ref={containerRef}
      className={cn("relative", className)}
        style={{
        ...style,
        transform: `rotate(${totalRotation}deg)`,
        transformOrigin: "center center",
        pointerEvents: (activeTool === "pan" || isSpacePressed) ? "none" : "auto",
      }}
      onMouseDown={!isEditing && activeTool !== "pan" && !isSpacePressed ? handleDragMouseDown : undefined}
    >
      {/* Hover border overlay - only show when select tool is active and not selected */}
      {isHovered && activeTool === "select" && !isSelected && !isEditing && (
        <div
          className="absolute border-2 border-primary pointer-events-none"
          style={{
            left: `-4px`,
            top: `-4px`,
            width: `${(size.width * scale) + 8}px`,
            height: `${(size.height * scale) + 8}px`,
            borderRadius: "4px",
            zIndex: 31,
            boxShadow: "0 0 0 2px rgba(59, 130, 246, 0.3)",
          }}
        />
      )}
      <div
        ref={editorRef}
        contentEditable={isEditing}
        onInput={handleInput}
        onPaste={handlePaste}
        onBlur={handleBlur}
        onDoubleClick={(e) => {
          // Double-click enters edit mode (Figma-style)
          if (!isEditing && onEditModeChange) {
            e.preventDefault();
            e.stopPropagation();
            if (e.nativeEvent && 'stopImmediatePropagation' in e.nativeEvent) {
              e.nativeEvent.stopImmediatePropagation();
            }
            
            // Cancel any active drag
            setIsDragging(false);
            
            // Enter edit mode immediately
            onEditModeChange(true);
            
            // Focus and place cursor at click position, not select all
            // This preserves the text position instead of centering it
            requestAnimationFrame(() => {
              editorRef.current?.focus();
              // Don't select all - just place cursor at the end to preserve text position
              const range = document.createRange();
              range.selectNodeContents(editorRef.current!);
              range.collapse(false); // Collapse to end (don't select)
              const selection = window.getSelection();
              selection?.removeAllRanges();
              selection?.addRange(range);
            });
          }
        }}
        onMouseDown={(e) => {
          if (isEditing) return; // In edit mode, allow normal text selection
          if (activeTool === "pan" || isSpacePressed) {
            // Don't drag when pan tool is active or space bar is pressed (space = pan shortcut)
            e.stopPropagation();
            return;
          }
          
          // Don't start drag if clicking on interactive elements
          const target = e.target as HTMLElement;
          if (
            target.closest('[data-corner-handle]') ||
            target.closest('[data-rotation-handle]') ||
            target.closest('button') ||
            target.closest('input[type="color"]')
          ) {
            return;
          }
          
          // Check for CTRL key for duplication
          if (e.ctrlKey || e.metaKey) {
            if (onDuplicate) {
              onDuplicate(e);
            }
            return; // Don't start normal drag when duplicating
          }
          
          // Start dragging immediately - double-click will cancel it
          setIsDragging(true);
          dragStartRef.current = { x: e.clientX, y: e.clientY };
        }}
        onClick={(e) => {
          // Single click: stop propagation to prevent container drag handler
          if (isEditing) {
            // In edit mode, allow normal text selection
            return;
          }
          // Not in edit mode - prevent text selection and stop propagation
          e.stopPropagation();
        }}
        className={cn(
          "px-3 py-2 outline-none rounded-lg transition-all duration-200",
          isSelected && "border border-primary/30 hover:border-primary/60 focus:border-primary",
          "resize-none overflow-auto",
          isSelected && "shadow-sm hover:shadow-md focus:shadow-lg",
          !isEditing && "cursor-pointer"
        )}
        style={{
          width: `${size.width * scale}px`,
          minHeight: `${size.height * scale}px`,
          maxWidth: annotation.autoFit ? "none" : `${size.width * scale}px`, // Only constrain width if not auto-fit
          fontSize: `${fontSize * scale}px`,
          fontFamily: annotation.fontFamily || "Arial",
          color: annotation.color || "rgba(0, 0, 0, 1)",
          // Use annotation.backgroundColor directly if available, otherwise use state
          backgroundColor: hasBackground 
            ? (annotation.backgroundColor !== undefined ? annotation.backgroundColor : (backgroundColor || "rgba(255, 255, 255, 0)"))
            : "rgba(255, 255, 255, 0)",
          userSelect: isEditing ? "text" : "none",
          WebkitUserSelect: isEditing ? "text" : "none",
          pointerEvents: (activeTool === "pan" || isSpacePressed) ? "none" : (isEditing ? "auto" : "auto"), // Disable when pan tool is active or space is pressed
          cursor: isEditing ? "text" : ((activeTool === "pan" || isSpacePressed) ? "default" : "move"), // Show default cursor when pan tool is active or space is pressed
          whiteSpace: annotation.autoFit ? "nowrap" : "pre-wrap", // No wrap for auto-fit, wrap for fixed box
          wordWrap: annotation.autoFit ? "normal" : "break-word", // Break long words only in fixed mode
          overflowWrap: annotation.autoFit ? "normal" : "break-word", // Break words only in fixed mode
        } as React.CSSProperties}
        suppressContentEditableWarning
        data-rich-text-editor="true"
        data-annotation-id={annotation.id}
        data-is-selected={isSelected ? "true" : "false"}
      />
      
      {/* Corner handles for resizing */}
      {isSelected && (
        <>
          {/* Top-left corner */}
          <div
            data-corner-handle="true"
            className="absolute"
            onMouseDown={(e) => handleCornerMouseDown(e, "nw")}
            onMouseEnter={() => setHoveredCorner("nw")}
            onMouseLeave={() => setHoveredCorner(null)}
            style={{
              top: `-${handleSize / 2}px`,
              left: `-${handleSize / 2}px`,
              width: `${handleSize}px`,
              height: `${handleSize}px`,
              cursor: "nwse-resize",
              zIndex: 30,
            }}
            title="Resize"
          >
            <div
              className="absolute bg-primary border border-primary/50 rounded transition-all pointer-events-auto"
              style={{
                width: `${handleSize}px`,
                height: `${handleSize}px`,
                backgroundColor: hoveredCorner === "nw" ? "rgb(59, 130, 246)" : undefined,
                borderColor: hoveredCorner === "nw" ? "rgb(37, 99, 235)" : undefined,
                transform: hoveredCorner === "nw" ? "scale(1.2)" : "scale(1)",
                transition: "all 0.15s ease",
                cursor: "nwse-resize",
              }}
            />
          </div>
          
          {/* Top-right corner */}
          <div
            data-corner-handle="true"
            className="absolute"
            onMouseDown={(e) => handleCornerMouseDown(e, "ne")}
            onMouseEnter={() => setHoveredCorner("ne")}
            onMouseLeave={() => setHoveredCorner(null)}
            style={{
              top: `-${handleSize / 2}px`,
              right: `-${handleSize / 2}px`,
              width: `${handleSize}px`,
              height: `${handleSize}px`,
              cursor: "nesw-resize",
              zIndex: 30,
            }}
            title="Resize"
          >
            <div
              className="absolute bg-primary border border-primary/50 rounded transition-all pointer-events-auto"
              style={{
                width: `${handleSize}px`,
                height: `${handleSize}px`,
                backgroundColor: hoveredCorner === "ne" ? "rgb(59, 130, 246)" : undefined,
                borderColor: hoveredCorner === "ne" ? "rgb(37, 99, 235)" : undefined,
                transform: hoveredCorner === "ne" ? "scale(1.2)" : "scale(1)",
                transition: "all 0.15s ease",
                cursor: "nesw-resize",
              }}
            />
          </div>
          
          {/* Bottom-left corner */}
          <div
            data-corner-handle="true"
            className="absolute"
            onMouseDown={(e) => handleCornerMouseDown(e, "sw")}
            onMouseEnter={() => setHoveredCorner("sw")}
            onMouseLeave={() => setHoveredCorner(null)}
            style={{
              bottom: `-${handleSize / 2}px`,
              left: `-${handleSize / 2}px`,
              width: `${handleSize}px`,
              height: `${handleSize}px`,
              cursor: "nesw-resize",
              zIndex: 30,
            }}
            title="Resize"
          >
            <div
              className="absolute bg-primary border border-primary/50 rounded transition-all pointer-events-auto"
              style={{
                width: `${handleSize}px`,
                height: `${handleSize}px`,
                backgroundColor: hoveredCorner === "sw" ? "rgb(59, 130, 246)" : undefined,
                borderColor: hoveredCorner === "sw" ? "rgb(37, 99, 235)" : undefined,
                transform: hoveredCorner === "sw" ? "scale(1.2)" : "scale(1)",
                transition: "all 0.15s ease",
                cursor: "nesw-resize",
              }}
            />
          </div>
          
          {/* Bottom-right corner */}
          <div
            data-corner-handle="true"
            className="absolute"
            onMouseDown={(e) => handleCornerMouseDown(e, "se")}
            onMouseEnter={() => setHoveredCorner("se")}
            onMouseLeave={() => setHoveredCorner(null)}
            style={{
              bottom: `-${handleSize / 2}px`,
              right: `-${handleSize / 2}px`,
              width: `${handleSize}px`,
              height: `${handleSize}px`,
              cursor: "nwse-resize",
              zIndex: 30,
            }}
            title="Resize"
          >
            <div
              className="absolute bg-primary border border-primary/50 rounded transition-all pointer-events-auto"
              style={{
                width: `${handleSize}px`,
                height: `${handleSize}px`,
                backgroundColor: hoveredCorner === "se" ? "rgb(59, 130, 246)" : undefined,
                borderColor: hoveredCorner === "se" ? "rgb(37, 99, 235)" : undefined,
                transform: hoveredCorner === "se" ? "scale(1.2)" : "scale(1)",
                transition: "all 0.15s ease",
                cursor: "nwse-resize",
              }}
            />
          </div>
          
          {/* Center-top rotation handle */}
          <div
            data-rotation-handle="true"
            className="absolute pointer-events-auto"
            onMouseDown={(e) => {
              if (activeTool === "pan" || isSpacePressed) {
                // Don't rotate when pan tool is active or space bar is pressed (space = pan shortcut)
                e.stopPropagation();
                return;
              }
              
              // Exit edit mode when starting to rotate
              if (isEditing && onEditModeChange) {
                onEditModeChange(false);
              }
              e.preventDefault();
              e.stopPropagation();
              if (!containerRef.current) return;
              const rect = containerRef.current.getBoundingClientRect();
              const centerX = rect.left + rect.width / 2;
              const centerY = rect.top + rect.height / 2;
              setIsRotating(true);
              setRotationStart({ 
                x: e.clientX, 
                y: e.clientY, 
                angle: rotation,
                centerX,
                centerY
              });
            }}
            onMouseEnter={() => {
              if (!isEditing) {
                setIsRotationHandleHovered(true);
              }
            }}
            onMouseLeave={() => {
              setIsRotationHandleHovered(false);
            }}
            style={{
              top: `-${rotationHandleOffset}px`,
              left: "50%",
              transform: "translateX(-50%)",
              width: `${rotationHandleSize}px`,
              height: `${rotationHandleSize}px`,
              cursor: isRotating ? "grabbing" : "grab",
              zIndex: 30,
            }}
            title="Rotate"
          >
            <RotationHandle 
              size={rotationHandleSize} 
              isHovered={isRotationHandleHovered}
              isActive={isRotating}
            />
          </div>
        </>
      )}
    </div>
  );
}







