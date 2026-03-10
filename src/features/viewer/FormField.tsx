/**
 * Form Field Component
 *
 * Renders interactive form fields for PDF annotations.
 * Font size scales dynamically based on field height.
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import type { Annotation } from "@/core/pdf/PDFEditor";
import { cn } from "@/lib/utils";
import { Settings } from "lucide-react";

// ---------------------------------------------------------------------------
// Shared helpers & sub-components
// ---------------------------------------------------------------------------

/** Calculate font size based on field height (60% of height, clamped 2–48px). */
function calculateFontSize(height: number): number {
  return Math.max(2, Math.min(Math.round(height * 0.6), 48));
}

/** Clean auto-generated field names for display as labels. */
function cleanFieldName(name: string): string {
  // Strip common auto-generated prefixes (text_1234567890, dropdown_1234567890, etc.)
  const cleaned = name.replace(/^(text|checkbox|radio|dropdown|date|number|email|signature|listbox|form)_\d+/i, "");
  if (!cleaned) return "";
  // Convert underscores/camelCase to readable form
  return cleaned.replace(/[_-]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
}

// -- Drag hook --

function useFormFieldDrag(
  isSelected: boolean,
  isLocked: boolean,
  activeTool: string,
  onMove: ((dx: number, dy: number) => void) | undefined,
  scale: number,
  zoomLevel: number,
) {
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (activeTool !== "select" && activeTool !== "selectText") return;
    if (isLocked || !isSelected || !onMove) return;
    const target = e.target as HTMLElement;
    if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(target.tagName)) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
  }, [activeTool, isLocked, isSelected, onMove]);

  useEffect(() => {
    if (!isDragging || !onMove) return;
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;
      const deltaScale = scale !== 1 ? scale : zoomLevel;
      const pdfDx = (e.clientX - dragStartRef.current.x) / deltaScale;
      const pdfDy = -(e.clientY - dragStartRef.current.y) / deltaScale;
      onMove(pdfDx, pdfDy);
      dragStartRef.current = { x: e.clientX, y: e.clientY };
    };
    const handleMouseUp = () => { setIsDragging(false); dragStartRef.current = null; };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => { window.removeEventListener("mousemove", handleMouseMove); window.removeEventListener("mouseup", handleMouseUp); };
  }, [isDragging, onMove, zoomLevel, scale]);

  return { isDragging, handleMouseDown };
}

// -- Wrapper --

interface FormFieldWrapperProps {
  annotation: Annotation;
  containerStyle: React.CSSProperties;
  isSelected: boolean;
  isDragging: boolean;
  isLocked: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onClick?: () => void;
  className?: string;
  children: React.ReactNode;
  /** Whether to show the field label above the field */
  showLabel?: boolean;
  value?: string | boolean;
}

function FormFieldWrapper({
  annotation,
  containerStyle,
  isSelected,
  isDragging,
  isLocked,
  onMouseDown,
  onClick,
  className,
  children,
  showLabel = true,
  value,
}: FormFieldWrapperProps) {
  const [isHovered, setIsHovered] = useState(false);

  // Determine display label
  const label = annotation.fieldLabel || cleanFieldName(annotation.fieldName || "");
  const hasValue = value !== undefined && value !== "" && value !== false;

  return (
    <div
      data-form-field="true"
      style={containerStyle}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={cn(
        isSelected && "rounded",
        isSelected && !isDragging && !isLocked && "cursor-move",
        !isSelected && isHovered && "ring-1 ring-blue-300 rounded",
        className,
      )}
    >
      {/* Field label */}
      {showLabel && label && !hasValue && (
        <div
          className="absolute text-gray-400 truncate pointer-events-none select-none"
          style={{
            top: "-15px",
            left: "0px",
            fontSize: "10px",
            lineHeight: "14px",
            maxWidth: `${parseFloat(containerStyle.width as string) || 100}px`,
          }}
        >
          {label}
        </div>
      )}
      {/* Required asterisk */}
      {annotation.required && !hasValue && (
        <div
          className="absolute text-red-500 pointer-events-none select-none font-bold"
          style={{
            top: "-14px",
            right: "0px",
            fontSize: "12px",
            lineHeight: "14px",
          }}
        >
          *
        </div>
      )}
      {/* Tooltip */}
      {annotation.tooltip && isHovered && !isSelected && (
        <div
          className="absolute bg-gray-900 text-white text-xs rounded px-2 py-1 pointer-events-none whitespace-nowrap"
          style={{ bottom: "-24px", left: "0px", zIndex: 1001 }}
        >
          {annotation.tooltip}
        </div>
      )}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom checkbox & radio SVGs
// ---------------------------------------------------------------------------

function CustomCheckbox({ checked, size, disabled, onChange }: { checked: boolean; size: number; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn("cursor-pointer", disabled && "opacity-50 cursor-not-allowed")}
      onClick={() => !disabled && onChange(!checked)}
      role="checkbox"
      aria-checked={checked}
    >
      <rect
        x="1" y="1" width="22" height="22" rx="4" ry="4"
        fill={checked ? "#3b82f6" : "white"}
        stroke={checked ? "#3b82f6" : "#d1d5db"}
        strokeWidth="2"
      />
      {checked && (
        <path d="M6 12l4 4 8-8" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function CustomRadio({ checked, size, disabled, onChange }: { checked: boolean; size: number; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn("cursor-pointer", disabled && "opacity-50 cursor-not-allowed")}
      onClick={() => !disabled && onChange(!checked)}
      role="radio"
      aria-checked={checked}
    >
      <circle
        cx="12" cy="12" r="11"
        fill={checked ? "#3b82f6" : "white"}
        stroke={checked ? "#3b82f6" : "#d1d5db"}
        strokeWidth="2"
      />
      {checked && <circle cx="12" cy="12" r="5" fill="white" />}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Shared input styles helper
// ---------------------------------------------------------------------------

function inputStyle(fontSize: number, hPad: string, extra?: React.CSSProperties): React.CSSProperties {
  return {
    fontSize: `${fontSize}px`,
    padding: `0 ${hPad}`,
    boxSizing: "border-box",
    width: "100%",
    height: "100%",
    minHeight: 0,
    maxHeight: "100%",
    border: "1px solid #d1d5db",
    margin: 0,
    lineHeight: 1,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface FormFieldProps {
  annotation: Annotation;
  pdfToCanvas: (pdfX: number, pdfY: number) => { x: number; y: number };
  onValueChange: (value: string | boolean) => void;
  onOptionsChange?: (options: string[]) => void;
  isEditable?: boolean;
  isSelected?: boolean;
  onClick?: () => void;
  onMove?: (deltaX: number, deltaY: number) => void;
  zoomLevel?: number;
  scale?: number;
  activeTool?: string;
}

export function FormField({
  annotation,
  pdfToCanvas,
  onValueChange,
  onOptionsChange,
  isEditable = true,
  isSelected = false,
  onClick,
  onMove,
  zoomLevel = 1,
  scale: scaleProp,
  activeTool = "select",
}: FormFieldProps) {
  const [value, setValue] = useState<string | boolean>(annotation.fieldValue || "");
  const [isEditingOptions, setIsEditingOptions] = useState(false);
  const [optionsText, setOptionsText] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => { setValue(annotation.fieldValue || ""); }, [annotation.fieldValue]);
  useEffect(() => { if (annotation.options) setOptionsText(annotation.options.join("\n")); }, [annotation.options]);

  if (!annotation.width || !annotation.height || !annotation.fieldType) return null;

  const scale = scaleProp ?? 1;
  const displayWidth = annotation.width * scale;
  const displayHeight = annotation.height * scale;
  const topLeft = pdfToCanvas(annotation.x, annotation.y + annotation.height);
  const fontSize = calculateFontSize(displayHeight);
  const isVerySmall = displayHeight < 10;
  const hPad = isVerySmall ? "1px" : "8px";
  const vPad = isVerySmall ? "0px" : "4px";
  const isLocked = annotation.locked === true;

  const { isDragging, handleMouseDown } = useFormFieldDrag(isSelected, isLocked, activeTool, onMove, scale, zoomLevel);

  const containerStyle: React.CSSProperties = {
    position: "absolute",
    left: `${topLeft.x}px`,
    top: `${topLeft.y}px`,
    width: `${displayWidth}px`,
    height: `${displayHeight}px`,
    zIndex: 500,
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    pointerEvents: "auto",
    ...(isSelected && { boxShadow: "inset 0 0 0 2px #3b82f6" }),
    ...(annotation.readOnly && !isSelected && { backgroundColor: "rgba(243,244,246,0.5)" }),
  };

  const handleChange = (newValue: string | boolean) => {
    setValue(newValue);
    setValidationError(null);
    onValueChange(newValue);
  };

  const handleSaveOptions = () => {
    const newOptions = optionsText.split("\n").filter(opt => opt.trim());
    if (onOptionsChange) onOptionsChange(newOptions);
    setIsEditingOptions(false);
  };

  const validateOnBlur = (val: string) => {
    if (annotation.validationType === "email" && val) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(val)) { setValidationError("Invalid email"); return; }
    }
    if (annotation.validationType === "number" && val) {
      if (isNaN(Number(val))) { setValidationError("Must be a number"); return; }
    }
    setValidationError(null);
  };

  const placeholder = annotation.placeholder
    || (annotation.required ? "Required" : (annotation.fieldType === "email" ? "email@example.com" : "Type here..."));

  const inputCn = cn(
    "rounded",
    "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent",
    "placeholder:text-gray-400 placeholder:italic",
    annotation.required && !value && "border-red-300",
    validationError && "border-red-500 ring-1 ring-red-300",
  );

  const wrapperProps = {
    annotation,
    containerStyle,
    isSelected,
    isDragging,
    isLocked,
    onMouseDown: handleMouseDown,
    onClick,
    value,
  };

  // ---- Text / Email / Number fields ----
  if (annotation.fieldType === "text" || annotation.fieldType === "email" || annotation.fieldType === "number") {
    const maxLen = annotation.maxLength;
    const align = annotation.textAlignment || "left";
    const color = annotation.fontColor;

    const handleTextChange = (raw: string) => {
      let val = raw;
      if (annotation.fieldType === "number") {
        // Allow digits, decimal, minus sign
        val = raw.replace(/[^0-9.\-]/g, "");
      }
      if (maxLen && val.length > maxLen) val = val.slice(0, maxLen);
      handleChange(val);
    };

    return (
      <FormFieldWrapper {...wrapperProps}>
        {annotation.multiline ? (
          <textarea
            key={`textarea-${annotation.id}`}
            value={value as string}
            onChange={(e) => handleTextChange(e.target.value)}
            onBlur={(e) => validateOnBlur(e.target.value)}
            disabled={!isEditable || annotation.readOnly}
            required={annotation.required}
            placeholder={placeholder}
            maxLength={maxLen}
            tabIndex={annotation.tabOrder}
            style={{
              ...inputStyle(fontSize, hPad, { padding: `${vPad} ${hPad}`, textAlign: align }),
              ...(color ? { color } : {}),
            }}
            className={cn(inputCn, "resize-none")}
          />
        ) : (
          <input
            key={`input-${annotation.id}`}
            type={annotation.fieldType === "email" ? "email" : "text"}
            inputMode={annotation.fieldType === "number" ? "numeric" : undefined}
            value={value as string}
            onChange={(e) => handleTextChange(e.target.value)}
            onBlur={(e) => validateOnBlur(e.target.value)}
            disabled={!isEditable || annotation.readOnly}
            required={annotation.required}
            placeholder={placeholder}
            maxLength={maxLen}
            tabIndex={annotation.tabOrder}
            style={{
              ...inputStyle(fontSize, hPad, { textAlign: align }),
              ...(color ? { color } : {}),
            }}
            className={inputCn}
          />
        )}
        {validationError && (
          <div className="absolute text-red-500 text-xs pointer-events-none" style={{ bottom: "-14px", left: "0" }}>
            {validationError}
          </div>
        )}
      </FormFieldWrapper>
    );
  }

  // ---- Checkbox ----
  if (annotation.fieldType === "checkbox") {
    const checkboxSize = Math.max(2, Math.min(annotation.width, annotation.height) * 0.7);
    return (
      <FormFieldWrapper {...wrapperProps} className="flex items-center justify-center">
        <CustomCheckbox
          checked={value as boolean}
          size={checkboxSize}
          disabled={!isEditable || !!annotation.readOnly}
          onChange={(v) => handleChange(v)}
        />
      </FormFieldWrapper>
    );
  }

  // ---- Radio ----
  if (annotation.fieldType === "radio") {
    const radioSize = Math.max(2, Math.min(annotation.width, annotation.height) * 0.7);
    return (
      <FormFieldWrapper {...wrapperProps} className="flex items-center justify-center">
        <CustomRadio
          checked={value as boolean}
          size={radioSize}
          disabled={!isEditable || !!annotation.readOnly}
          onChange={(v) => handleChange(v)}
        />
      </FormFieldWrapper>
    );
  }

  // ---- Dropdown ----
  if (annotation.fieldType === "dropdown") {
    const options = annotation.options || [];
    return (
      <FormFieldWrapper {...wrapperProps} containerStyle={{ ...containerStyle, overflow: "visible" }}>
        <div className="relative w-full h-full" style={{ overflow: "visible" }}>
          <select
            value={value as string}
            onChange={(e) => handleChange(e.target.value)}
            disabled={!isEditable || annotation.readOnly}
            required={annotation.required}
            tabIndex={annotation.tabOrder}
            style={inputStyle(fontSize, hPad)}
            className={cn(
              "rounded bg-white",
              "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent",
              !value && "text-gray-400 italic",
              annotation.required && !value && "border-red-300",
            )}
          >
            <option value="" className="text-gray-400 italic">{annotation.placeholder || "Click to select..."}</option>
            {options.map((option, i) => (
              <option key={i} value={option} className="text-black not-italic">{option}</option>
            ))}
          </select>
          {isSelected && onOptionsChange && !isEditingOptions && (
            <button
              data-form-field-button="true"
              onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
              onClick={(e) => { e.stopPropagation(); e.preventDefault(); setIsEditingOptions(true); }}
              className="absolute bg-blue-500 text-white rounded-full shadow-md hover:bg-blue-600 transition-colors flex items-center justify-center"
              style={{ top: "-20px", right: "-20px", width: "20px", height: "20px", zIndex: 1000 }}
              title="Edit Options"
            >
              <Settings className="text-white" style={{ width: "12px", height: "12px" }} />
            </button>
          )}
          {isEditingOptions && createPortal(
            <>
              <div className="fixed inset-0 bg-black/30" style={{ zIndex: 99998 }} onClick={() => setIsEditingOptions(false)} />
              <div
                className="bg-white border-2 border-blue-500 rounded-lg shadow-2xl p-4"
                style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: "320px", zIndex: 99999 }}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div className="text-base font-semibold mb-3">Edit Dropdown Options</div>
                <div className="text-sm text-gray-500 mb-2">Enter one option per line:</div>
                <textarea
                  value={optionsText}
                  onChange={(e) => setOptionsText(e.target.value)}
                  className="w-full h-40 px-3 py-2 text-sm border rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder={"Option 1\nOption 2\nOption 3"}
                  autoFocus
                />
                <div className="flex gap-2 mt-4">
                  <button onClick={handleSaveOptions} className="flex-1 px-4 py-2 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600 transition-colors">Save</button>
                  <button onClick={() => setIsEditingOptions(false)} className="flex-1 px-4 py-2 bg-gray-100 border border-gray-300 rounded-md text-sm font-medium hover:bg-gray-200 transition-colors">Cancel</button>
                </div>
              </div>
            </>,
            document.body,
          )}
        </div>
      </FormFieldWrapper>
    );
  }

  // ---- List Box (multi-select) ----
  if (annotation.fieldType === "listbox") {
    const options = annotation.options || [];
    const selectedValues = (value as string || "").split(",").filter(Boolean);
    return (
      <FormFieldWrapper {...wrapperProps}>
        <select
          multiple
          value={selectedValues}
          onChange={(e) => {
            const selected = Array.from(e.target.selectedOptions, o => o.value);
            handleChange(selected.join(","));
          }}
          disabled={!isEditable || annotation.readOnly}
          tabIndex={annotation.tabOrder}
          style={inputStyle(fontSize, hPad)}
          className={cn(
            "rounded bg-white",
            "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent",
            annotation.required && !value && "border-red-300",
          )}
        >
          {options.map((option, i) => (
            <option key={i} value={option}>{option}</option>
          ))}
        </select>
      </FormFieldWrapper>
    );
  }

  // ---- Date ----
  if (annotation.fieldType === "date") {
    return (
      <FormFieldWrapper {...wrapperProps}>
        <input
          type="date"
          value={value as string}
          onChange={(e) => handleChange(e.target.value)}
          disabled={!isEditable || annotation.readOnly}
          required={annotation.required}
          tabIndex={annotation.tabOrder}
          placeholder="Select date..."
          style={inputStyle(fontSize, hPad)}
          className={cn(
            "rounded bg-white",
            "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent",
            !value && "text-gray-400",
            annotation.required && !value && "border-red-300",
          )}
        />
      </FormFieldWrapper>
    );
  }

  // ---- Signature ----
  if (annotation.fieldType === "signature") {
    const hasSignature = !!(annotation.fieldValue && typeof annotation.fieldValue === "string" && annotation.fieldValue.startsWith("data:"));
    return (
      <FormFieldWrapper {...wrapperProps} showLabel={!hasSignature}>
        <div
          className={cn(
            "w-full h-full flex items-center justify-center rounded cursor-pointer",
            hasSignature ? "bg-white" : "bg-gray-50 border-2 border-dashed border-gray-300 hover:border-blue-400 hover:bg-blue-50/30",
          )}
          onClick={() => {
            if (!isEditable || annotation.readOnly) return;
            // Dispatch event for external signature capture dialog
            window.dispatchEvent(new CustomEvent("formFieldSignatureRequest", {
              detail: { annotationId: annotation.id },
            }));
          }}
          tabIndex={annotation.tabOrder}
        >
          {hasSignature ? (
            <img
              src={annotation.fieldValue as string}
              alt="Signature"
              className="max-w-full max-h-full object-contain"
            />
          ) : (
            <span className="text-gray-400 italic select-none" style={{ fontSize: `${Math.max(10, fontSize * 0.7)}px` }}>
              Click to sign
            </span>
          )}
        </div>
      </FormFieldWrapper>
    );
  }

  return null;
}
