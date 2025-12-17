/**
 * Form Field Component
 * 
 * Renders interactive form fields for PDF annotations
 * Font size scales dynamically based on field height
 */

import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Annotation } from "@/core/pdf/PDFEditor";
import { cn } from "@/lib/utils";
import { Settings, Lock, Unlock } from "lucide-react";

interface FormFieldProps {
  annotation: Annotation;
  pdfToCanvas: (pdfX: number, pdfY: number) => { x: number; y: number };
  onValueChange: (value: string | boolean) => void;
  onOptionsChange?: (options: string[]) => void;
  onLockChange?: (locked: boolean) => void;
  isEditable?: boolean;
  isSelected?: boolean;
  onClick?: () => void;
  onMove?: (deltaX: number, deltaY: number) => void;
  zoomLevel?: number;
  activeTool?: string; // Current active tool - prevents interaction when non-select tools are active
}

// Calculate font size based on field height (60% of height, clamped between 2px and 48px)
function calculateFontSize(height: number): number {
  const fontSize = Math.round(height * 0.6);
  return Math.max(2, Math.min(fontSize, 48));
}

export function FormField({
  annotation,
  pdfToCanvas,
  onValueChange,
  onOptionsChange,
  onLockChange,
  isEditable = true,
  isSelected = false,
  onClick,
  onMove,
  zoomLevel = 1,
  activeTool = "select",
}: FormFieldProps) {
  const [value, setValue] = useState<string | boolean>(annotation.fieldValue || "");
  const [isEditingOptions, setIsEditingOptions] = useState(false);
  const [optionsText, setOptionsText] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    setValue(annotation.fieldValue || "");
  }, [annotation.fieldValue]);

  useEffect(() => {
    if (annotation.options) {
      setOptionsText(annotation.options.join("\n"));
    }
  }, [annotation.options]);

  if (!annotation.width || !annotation.height || !annotation.fieldType) return null;

  // Convert PDF coordinates to canvas coordinates
  // Don't apply zoom here - the parent container is already transformed
  const topLeft = pdfToCanvas(annotation.x, annotation.y + annotation.height);
  
  // Calculate dynamic font size based on field height
  const fontSize = calculateFontSize(annotation.height);
  
  // For very small heights, reduce or remove padding to prevent overflow
  const isVerySmall = annotation.height < 10;
  const horizontalPadding = isVerySmall ? "1px" : "8px";
  const verticalPadding = isVerySmall ? "0px" : "4px";
  
  const containerStyle: React.CSSProperties = {
    position: "absolute",
    left: `${topLeft.x}px`,
    top: `${topLeft.y}px`,
    width: `${annotation.width}px`,
    height: `${annotation.height}px`,
    zIndex: 500,
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    pointerEvents: (activeTool === "select" || activeTool === "selectText") ? "auto" : "none", // Disable interaction when non-select tools are active
    ...(isSelected && {
      boxShadow: "inset 0 0 0 2px #3b82f6",
    }),
  };

  const handleChange = (newValue: string | boolean) => {
    setValue(newValue);
    onValueChange(newValue);
  };

  const handleSaveOptions = () => {
    const newOptions = optionsText.split("\n").filter(opt => opt.trim());
    if (onOptionsChange) {
      onOptionsChange(newOptions);
    }
    setIsEditingOptions(false);
  };

  // Check if field is locked
  const isLocked = (annotation as any).locked === true;
  
  // Handle drag to move form field
  const handleMouseDown = (e: React.MouseEvent) => {
    // Don't allow interaction when non-select tools are active
    if (activeTool !== "select" && activeTool !== "selectText") return;
    
    // Don't allow dragging if locked
    if (isLocked) return;
    
    // Only allow dragging when selected and not clicking on input elements
    if (!isSelected || !onMove) return;
    
    const target = e.target as HTMLElement;
    // Don't drag if clicking on input, select, textarea, or button
    if (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA" || target.tagName === "BUTTON") {
      return;
    }
    
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
  };
  
  const handleLockToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (onLockChange) {
      onLockChange(!isLocked);
    }
  };

  useEffect(() => {
    if (!isDragging || !onMove) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;
      
      // Calculate screen pixel delta
      const screenDx = e.clientX - dragStartRef.current.x;
      const screenDy = e.clientY - dragStartRef.current.y;
      
      // Convert screen delta to PDF delta using zoom level (same as RichTextEditor)
      const pdfDx = screenDx / zoomLevel;
      const pdfDy = -screenDy / zoomLevel; // Flip Y for PDF coordinates
      
      onMove(pdfDx, pdfDy);
      
      // Update drag start for next incremental delta
      dragStartRef.current = { x: e.clientX, y: e.clientY };
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, onMove, zoomLevel]);

  // Text input field
  if (annotation.fieldType === "text") {
    const placeholder = annotation.required ? "Required - Type here to fill in" : "Type here to fill in";
    
    return (
      <div 
        style={containerStyle}
        onClick={onClick}
        onMouseDown={handleMouseDown}
        className={cn(
          isSelected && "rounded",
          isSelected && !isDragging && !isLocked && "cursor-move"
        )}
      >
        {/* Lock button - show for all form field types when selected */}
        {isSelected && onLockChange && (
          <button
            data-form-field-button="true"
            onMouseDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
            }}
            onClick={handleLockToggle}
            className="absolute bg-blue-500 text-white rounded-full shadow-md hover:bg-blue-600 transition-colors flex items-center justify-center"
            style={{
              top: "-20px",
              left: "-20px",
              width: "20px",
              height: "20px",
              zIndex: 1000,
            }}
            title={isLocked ? "Unlock position" : "Lock position"}
          >
            {isLocked ? (
              <Lock className="text-white" style={{ width: "12px", height: "12px" }} />
            ) : (
              <Unlock className="text-white" style={{ width: "12px", height: "12px" }} />
            )}
          </button>
        )}
        {annotation.multiline ? (
          <textarea
            key={`textarea-${annotation.id}`}
            value={value as string}
            onChange={(e) => handleChange(e.target.value)}
            disabled={!isEditable || annotation.readOnly}
            required={annotation.required}
            placeholder={placeholder}
            style={{ 
              fontSize: `${fontSize}px`, 
              lineHeight: 1,
              padding: `${verticalPadding} ${horizontalPadding}`,
              boxSizing: "border-box",
              width: "100%",
              height: "100%",
              minHeight: 0,
              maxHeight: "100%",
              border: "1px solid #d1d5db",
              margin: 0,
            }}
            className={cn(
              "rounded resize-none",
              "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent",
              "placeholder:text-gray-400 placeholder:italic",
              annotation.required && !value && "border-red-300"
            )}
          />
        ) : (
          <input
            key={`input-${annotation.id}`}
            type="text"
            value={value as string}
            onChange={(e) => handleChange(e.target.value)}
            disabled={!isEditable || annotation.readOnly}
            required={annotation.required}
            placeholder={placeholder}
            style={{ 
              fontSize: `${fontSize}px`,
              padding: `0 ${horizontalPadding}`,
              boxSizing: "border-box",
              width: "100%",
              height: "100%",
              minHeight: 0,
              maxHeight: "100%",
              border: "1px solid #d1d5db",
              margin: 0,
              lineHeight: 1,
            }}
            className={cn(
              "rounded",
              "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent",
              "placeholder:text-gray-400 placeholder:italic",
              annotation.required && !value && "border-red-300"
            )}
          />
        )}
      </div>
    );
  }

  // Checkbox field
  if (annotation.fieldType === "checkbox") {
    // Scale checkbox size based on field dimensions (use smaller dimension)
    // Allow very small sizes - minimum 2px
    const checkboxSize = Math.max(2, Math.min(annotation.width, annotation.height) * 0.7);
    
    return (
      <div 
        style={containerStyle} 
        className={cn(
          "flex items-center justify-center",
          isSelected && "rounded",
          isSelected && !isDragging && !isLocked && "cursor-move"
        )}
        onClick={onClick}
        onMouseDown={handleMouseDown}
      >
        {/* Lock button */}
        {isSelected && onLockChange && (
          <button
            data-form-field-button="true"
            onMouseDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
            }}
            onClick={handleLockToggle}
            className="absolute bg-blue-500 text-white rounded-full shadow-md hover:bg-blue-600 transition-colors flex items-center justify-center"
            style={{
              top: "-20px",
              left: "-20px",
              width: "20px",
              height: "20px",
              zIndex: 1000,
            }}
            title={isLocked ? "Unlock position" : "Lock position"}
          >
            {isLocked ? (
              <Lock className="text-white" style={{ width: "12px", height: "12px" }} />
            ) : (
              <Unlock className="text-white" style={{ width: "12px", height: "12px" }} />
            )}
          </button>
        )}
        <input
          type="checkbox"
          checked={value as boolean}
          onChange={(e) => handleChange(e.target.checked)}
          disabled={!isEditable || annotation.readOnly}
          className="cursor-pointer accent-blue-500"
          style={{ width: `${checkboxSize}px`, height: `${checkboxSize}px` }}
        />
      </div>
    );
  }

  // Radio button field
  if (annotation.fieldType === "radio") {
    // Scale radio size based on field dimensions (use smaller dimension)
    // Allow very small sizes - minimum 2px
    const radioSize = Math.max(2, Math.min(annotation.width, annotation.height) * 0.7);
    
    return (
      <div 
        style={containerStyle} 
        className={cn(
          "flex items-center justify-center",
          isSelected && "rounded",
          isSelected && !isDragging && !isLocked && "cursor-move"
        )}
        onClick={onClick}
        onMouseDown={handleMouseDown}
      >
        {/* Lock button */}
        {isSelected && onLockChange && (
          <button
            data-form-field-button="true"
            onMouseDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
            }}
            onClick={handleLockToggle}
            className="absolute bg-blue-500 text-white rounded-full shadow-md hover:bg-blue-600 transition-colors flex items-center justify-center"
            style={{
              top: "-20px",
              left: "-20px",
              width: "20px",
              height: "20px",
              zIndex: 1000,
            }}
            title={isLocked ? "Unlock position" : "Lock position"}
          >
            {isLocked ? (
              <Lock className="text-white" style={{ width: "12px", height: "12px" }} />
            ) : (
              <Unlock className="text-white" style={{ width: "12px", height: "12px" }} />
            )}
          </button>
        )}
        <input
          type="radio"
          name={annotation.radioGroup || annotation.fieldName}
          checked={value as boolean}
          onChange={(e) => handleChange(e.target.checked)}
          disabled={!isEditable || annotation.readOnly}
          className="cursor-pointer accent-blue-500"
          style={{ width: `${radioSize}px`, height: `${radioSize}px` }}
        />
      </div>
    );
  }

  // Dropdown field
  if (annotation.fieldType === "dropdown") {
    const options = annotation.options || [];
    
    return (
      <div 
        style={{...containerStyle, overflow: "visible"}}
        onClick={onClick}
        onMouseDown={handleMouseDown}
        className={cn(
          isSelected && "rounded",
          isSelected && !isDragging && !isLocked && "cursor-move"
        )}
      >
        <div className="relative w-full h-full" style={{ overflow: "visible" }}>
          {/* Lock button - positioned to the left of the gear icon */}
          {isSelected && onLockChange && (
            <button
              data-form-field-button="true"
              onMouseDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
              }}
              onClick={handleLockToggle}
              className="absolute bg-blue-500 text-white rounded-full shadow-md hover:bg-blue-600 transition-colors flex items-center justify-center"
              style={{
                top: "-20px",
                left: "-20px",
                width: "20px",
                height: "20px",
                zIndex: 1000,
              }}
              title={isLocked ? "Unlock position" : "Lock position"}
            >
              {isLocked ? (
                <Lock className="text-white" style={{ width: "12px", height: "12px" }} />
              ) : (
                <Unlock className="text-white" style={{ width: "12px", height: "12px" }} />
              )}
            </button>
          )}
          <select
            value={value as string}
            onChange={(e) => handleChange(e.target.value)}
            disabled={!isEditable || annotation.readOnly}
            required={annotation.required}
            style={{ 
              fontSize: `${fontSize}px`,
              padding: `0 ${horizontalPadding}`,
              boxSizing: "border-box",
              width: "100%",
              height: "100%",
              minHeight: 0,
              border: "1px solid #d1d5db",
              margin: 0,
            }}
            className={cn(
              "rounded bg-white",
              "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent",
              !value && "text-gray-400 italic",
              annotation.required && !value && "border-red-300"
            )}
          >
            <option value="" className="text-gray-400 italic">Click to select...</option>
            {options.map((option, index) => (
              <option key={index} value={option} className="text-black not-italic">
                {option}
              </option>
            ))}
          </select>
          {isSelected && onOptionsChange && !isEditingOptions && (
            <button
              data-form-field-button="true"
              onMouseDown={(e) => {
                // Prevent the mousedown from bubbling up and triggering deselection
                e.stopPropagation();
                e.preventDefault();
              }}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setIsEditingOptions(true);
              }}
              className="absolute bg-blue-500 text-white rounded-full shadow-md hover:bg-blue-600 transition-colors flex items-center justify-center"
              style={{
                top: "-20px",
                right: "-20px",
                width: "20px",
                height: "20px",
                zIndex: 1000,
              }}
              title="Edit Options"
            >
              <Settings 
                className="text-white" 
                style={{ 
                  width: "12px", 
                  height: "12px" 
                }} 
              />
            </button>
          )}
          {isEditingOptions && createPortal(
            <>
              {/* Backdrop */}
              <div 
                className="fixed inset-0 bg-black/30"
                style={{ zIndex: 99998 }}
                onClick={() => setIsEditingOptions(false)}
              />
              {/* Modal */}
              <div 
                className="bg-white border-2 border-blue-500 rounded-lg shadow-2xl p-4"
                style={{
                  position: "fixed",
                  top: "50%",
                  left: "50%",
                  transform: "translate(-50%, -50%)",
                  width: "320px",
                  zIndex: 99999,
                }}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div className="text-base font-semibold mb-3">Edit Dropdown Options</div>
                <div className="text-sm text-gray-500 mb-2">Enter one option per line:</div>
                <textarea
                  value={optionsText}
                  onChange={(e) => setOptionsText(e.target.value)}
                  className="w-full h-40 px-3 py-2 text-sm border rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Option 1&#10;Option 2&#10;Option 3"
                  autoFocus
                />
                <div className="flex gap-2 mt-4">
                  <button
                    onClick={handleSaveOptions}
                    className="flex-1 px-4 py-2 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600 transition-colors"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setIsEditingOptions(false)}
                    className="flex-1 px-4 py-2 bg-gray-100 border border-gray-300 rounded-md text-sm font-medium hover:bg-gray-200 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </>,
            document.body
          )}
        </div>
      </div>
    );
  }

  // Date picker field
  if (annotation.fieldType === "date") {
    return (
      <div 
        style={containerStyle}
        onClick={onClick}
        onMouseDown={handleMouseDown}
        className={cn(
          isSelected && "rounded",
          isSelected && !isDragging && !isLocked && "cursor-move"
        )}
      >
        {/* Lock button */}
        {isSelected && onLockChange && (
          <button
            data-form-field-button="true"
            onMouseDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
            }}
            onClick={handleLockToggle}
            className="absolute bg-blue-500 text-white rounded-full shadow-md hover:bg-blue-600 transition-colors flex items-center justify-center"
            style={{
              top: "-20px",
              left: "-20px",
              width: "20px",
              height: "20px",
              zIndex: 1000,
            }}
            title={isLocked ? "Unlock position" : "Lock position"}
          >
            {isLocked ? (
              <Lock className="text-white" style={{ width: "12px", height: "12px" }} />
            ) : (
              <Unlock className="text-white" style={{ width: "12px", height: "12px" }} />
            )}
          </button>
        )}
        <input
          type="date"
          value={value as string}
          onChange={(e) => handleChange(e.target.value)}
          disabled={!isEditable || annotation.readOnly}
          required={annotation.required}
          placeholder="Select date..."
          style={{ 
            fontSize: `${fontSize}px`,
            padding: `0 ${horizontalPadding}`,
            boxSizing: "border-box",
            width: "100%",
            height: "100%",
            border: "1px solid #d1d5db",
          }}
          className={cn(
            "rounded bg-white",
            "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent",
            !value && "text-gray-400",
            annotation.required && !value && "border-red-300"
          )}
        />
      </div>
    );
  }

  return null;
}

