/**
 * Form Field Component
 * 
 * Renders interactive form fields for PDF annotations
 * Font size scales dynamically based on field height
 */

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import type { Annotation } from "@/core/pdf/PDFEditor";
import { cn } from "@/lib/utils";
import { Settings } from "lucide-react";

interface FormFieldProps {
  annotation: Annotation;
  pdfToCanvas: (pdfX: number, pdfY: number) => { x: number; y: number };
  onValueChange: (value: string | boolean) => void;
  onOptionsChange?: (options: string[]) => void;
  isEditable?: boolean;
  isSelected?: boolean;
  onClick?: () => void;
}

// Calculate font size based on field height (60% of height, clamped between 10px and 48px)
function calculateFontSize(height: number): number {
  const fontSize = Math.round(height * 0.6);
  return Math.max(10, Math.min(fontSize, 48));
}

export function FormField({
  annotation,
  pdfToCanvas,
  onValueChange,
  onOptionsChange,
  isEditable = true,
  isSelected = false,
  onClick,
}: FormFieldProps) {
  const [value, setValue] = useState<string | boolean>(annotation.fieldValue || "");
  const [isEditingOptions, setIsEditingOptions] = useState(false);
  const [optionsText, setOptionsText] = useState("");

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
  
  const containerStyle: React.CSSProperties = {
    position: "absolute",
    left: `${topLeft.x}px`,
    top: `${topLeft.y}px`,
    width: `${annotation.width}px`,
    height: `${annotation.height}px`,
    zIndex: 500,
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

  // Text input field
  if (annotation.fieldType === "text") {
    const placeholder = annotation.required ? "Required - Type here to fill in" : "Type here to fill in";
    
    return (
      <div 
        style={containerStyle}
        onClick={onClick}
        className={cn(isSelected && "ring-2 ring-blue-500 rounded")}
      >
        {annotation.multiline ? (
          <textarea
            value={value as string}
            onChange={(e) => handleChange(e.target.value)}
            disabled={!isEditable || annotation.readOnly}
            required={annotation.required}
            placeholder={placeholder}
            style={{ fontSize: `${fontSize}px`, lineHeight: 1.2 }}
            className={cn(
              "w-full h-full px-2 py-1 border border-gray-300 rounded resize-none",
              "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent",
              "placeholder:text-gray-400 placeholder:italic",
              annotation.required && !value && "border-red-300"
            )}
          />
        ) : (
          <input
            type="text"
            value={value as string}
            onChange={(e) => handleChange(e.target.value)}
            disabled={!isEditable || annotation.readOnly}
            required={annotation.required}
            placeholder={placeholder}
            style={{ fontSize: `${fontSize}px` }}
            className={cn(
              "w-full h-full px-2 border border-gray-300 rounded",
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
    const checkboxSize = Math.max(12, Math.min(annotation.width, annotation.height) * 0.7);
    
    return (
      <div 
        style={containerStyle} 
        className={cn("flex items-center justify-center", isSelected && "ring-2 ring-blue-500 rounded")}
        onClick={onClick}
      >
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
    const radioSize = Math.max(12, Math.min(annotation.width, annotation.height) * 0.7);
    
    return (
      <div 
        style={containerStyle} 
        className={cn("flex items-center justify-center", isSelected && "ring-2 ring-blue-500 rounded")}
        onClick={onClick}
      >
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
        className={cn(isSelected && "ring-2 ring-blue-500 rounded")}
      >
        <div className="relative w-full h-full" style={{ overflow: "visible" }}>
          <select
            value={value as string}
            onChange={(e) => handleChange(e.target.value)}
            disabled={!isEditable || annotation.readOnly}
            required={annotation.required}
            style={{ fontSize: `${fontSize}px` }}
            className={cn(
              "w-full h-full px-2 border border-gray-300 rounded bg-white",
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
              className="absolute p-1.5 bg-blue-500 text-white rounded text-xs flex items-center gap-1 shadow-md hover:bg-blue-600 transition-colors"
              style={{
                top: "-28px",
                right: "0px",
                zIndex: 1000,
              }}
            >
              <Settings className="h-3 w-3" />
              Edit Options
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
        className={cn(isSelected && "ring-2 ring-blue-500 rounded")}
      >
        <input
          type="date"
          value={value as string}
          onChange={(e) => handleChange(e.target.value)}
          disabled={!isEditable || annotation.readOnly}
          required={annotation.required}
          placeholder="Select date..."
          style={{ fontSize: `${fontSize}px` }}
          className={cn(
            "w-full h-full px-2 border border-gray-300 rounded bg-white",
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

