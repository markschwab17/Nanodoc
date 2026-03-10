/**
 * Form Field Properties Panel
 *
 * A floating panel that displays and allows editing of form field properties
 * when a form field annotation is selected. Replaces AnnotationPropertiesPanel
 * for formField type annotations.
 */

import { useState, useEffect, useCallback } from "react";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useUIStore } from "@/shared/stores/uiStore";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { Annotation } from "@/core/pdf/types";

export function FormFieldPropertiesPanel() {
  const { currentPage, getCurrentDocument, getAnnotations, updateAnnotation } = usePDFStore();
  const currentDocument = getCurrentDocument();

  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  // Resolve annotation
  const annotation: Annotation | null = (() => {
    if (!selectedAnnotationId || !currentDocument) return null;
    const annotations = getAnnotations(currentDocument.getId());
    return annotations.find((a) => a.id === selectedAnnotationId) ?? null;
  })();

  // Only show for formField type
  const isFormField = annotation?.type === "formField";

  const handleAnnotationSelected = useCallback((e: Event) => {
    const detail = (e as CustomEvent<{ annotationId?: string }>).detail;
    if (detail?.annotationId) setSelectedAnnotationId(detail.annotationId);
  }, []);

  const handleAnnotationDeselected = useCallback(() => {
    setSelectedAnnotationId(null);
  }, []);

  useEffect(() => {
    window.addEventListener("annotationSelected", handleAnnotationSelected);
    window.addEventListener("annotationDeselected", handleAnnotationDeselected);
    return () => {
      window.removeEventListener("annotationSelected", handleAnnotationSelected);
      window.removeEventListener("annotationDeselected", handleAnnotationDeselected);
    };
  }, [handleAnnotationSelected, handleAnnotationDeselected]);

  // In single-page mode, clear selection when navigating pages
  // (Don't clear in read mode — currentPage changes on scroll and would break selection)
  const { readMode } = useUIStore();
  useEffect(() => { if (!readMode) setSelectedAnnotationId(null); }, [currentPage, readMode]);

  if (!annotation || !isFormField || !currentDocument) return null;

  const docId = currentDocument.getId();

  const update = (updates: Partial<Annotation>) => {
    updateAnnotation(docId, annotation.id, updates);
  };

  // Get existing radio groups on the same page
  const allAnnotations = getAnnotations(docId);
  const radioGroups = Array.from(
    new Set(
      allAnnotations
        .filter((a) => a.type === "formField" && a.fieldType === "radio" && a.radioGroup)
        .map((a) => a.radioGroup!)
    )
  );

  const fieldTypeLabel: Record<string, string> = {
    text: "Text Field",
    number: "Number Field",
    email: "Email Field",
    checkbox: "Checkbox",
    radio: "Radio Button",
    dropdown: "Dropdown",
    listbox: "List Box",
    date: "Date Picker",
    signature: "Signature",
  };

  return (
    <div className="flex-shrink-0 border-t border-border bg-background text-xs select-none">
      {/* Header */}
      <button
        className="flex w-full items-center justify-between px-3 py-1 cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className="font-medium text-foreground">
          {fieldTypeLabel[annotation.fieldType || "text"] || "Form Field"} Properties
        </span>
        {collapsed ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        ) : (
          <ChevronUp className="h-3 w-3 text-muted-foreground" />
        )}
      </button>

      {/* Body */}
      {!collapsed && (
        <div className="px-3 pb-2 pt-0.5 flex flex-wrap gap-x-4 gap-y-1.5 items-start max-h-[120px] overflow-y-auto">
          {/* Layout info */}
          <div className="flex items-center gap-1 text-muted-foreground">
            <span>Page {annotation.pageNumber + 1}</span>
            <span className="text-border">|</span>
            <span>{Math.round(annotation.x)}, {Math.round(annotation.y)}</span>
            {annotation.width != null && annotation.height != null && (
              <>
                <span className="text-border">|</span>
                <span>{Math.round(annotation.width)} x {Math.round(annotation.height)}</span>
              </>
            )}
          </div>

          {/* Identity fields */}
          <InlineField label="Name" value={annotation.fieldName || ""} onChange={(v) => update({ fieldName: v })} placeholder="field_name" />
          <InlineField label="Label" value={annotation.fieldLabel || ""} onChange={(v) => update({ fieldLabel: v })} placeholder="Label" />
          <InlineField label="Tooltip" value={annotation.tooltip || ""} onChange={(v) => update({ tooltip: v })} placeholder="Hover text" />

          {/* Behavior toggles */}
          <div className="flex items-center gap-2">
            <ToggleRow label="Required" checked={!!annotation.required} onChange={(v) => update({ required: v })} />
            <ToggleRow label="Read Only" checked={!!annotation.readOnly} onChange={(v) => update({ readOnly: v })} />
            <ToggleRow label="Locked" checked={!!annotation.locked} onChange={(v) => update({ locked: v })} />
          </div>

          {/* Text-specific */}
          {(annotation.fieldType === "text" || annotation.fieldType === "number" || annotation.fieldType === "email") && (
            <>
              <InlineField label="Placeholder" value={annotation.placeholder || ""} onChange={(v) => update({ placeholder: v })} placeholder="Placeholder" />
              {annotation.fieldType === "text" && (
                <ToggleRow label="Multiline" checked={!!annotation.multiline} onChange={(v) => update({ multiline: v })} />
              )}
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground">Max:</span>
                <input
                  type="number"
                  value={annotation.maxLength || ""}
                  onChange={(e) => update({ maxLength: e.target.value ? parseInt(e.target.value) : undefined })}
                  className="w-12 px-1 py-0.5 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="–"
                  min={0}
                />
              </div>
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground">Align:</span>
                <select
                  value={annotation.textAlignment || "left"}
                  onChange={(e) => update({ textAlignment: e.target.value as "left" | "center" | "right" })}
                  className="px-1 py-0.5 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                </select>
              </div>
              {annotation.fieldType === "text" && (
                <div className="flex items-center gap-1">
                  <span className="text-muted-foreground">Validate:</span>
                  <select
                    value={annotation.validationType || "none"}
                    onChange={(e) => update({ validationType: e.target.value as "none" | "email" | "number" })}
                    className="px-1 py-0.5 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="none">None</option>
                    <option value="email">Email</option>
                    <option value="number">Number</option>
                  </select>
                </div>
              )}
            </>
          )}

          {/* Radio-specific */}
          {annotation.fieldType === "radio" && (
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground">Group:</span>
              <input
                type="text"
                value={annotation.radioGroup || ""}
                onChange={(e) => update({ radioGroup: e.target.value })}
                className="w-24 px-1 py-0.5 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="Group name"
                list="radio-groups"
              />
              <datalist id="radio-groups">
                {radioGroups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </div>
          )}

          {/* Dropdown/Listbox options */}
          {(annotation.fieldType === "dropdown" || annotation.fieldType === "listbox") && (
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground">Options:</span>
              <input
                type="text"
                value={(annotation.options || []).join(", ")}
                onChange={(e) => {
                  const opts = e.target.value.split(",").map((o) => o.trim()).filter(Boolean);
                  update({ options: opts });
                }}
                className="w-40 px-1 py-0.5 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="Opt 1, Opt 2, Opt 3"
              />
            </div>
          )}

          {/* Tab order */}
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">Tab:</span>
            <input
              type="number"
              value={annotation.tabOrder ?? ""}
              onChange={(e) => update({ tabOrder: e.target.value ? parseInt(e.target.value) : undefined })}
              className="w-10 px-1 py-0.5 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="–"
              min={0}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function InlineField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-muted-foreground">{label}:</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-24 px-1 py-0.5 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
        placeholder={placeholder}
      />
    </div>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1 cursor-pointer">
      <span className="text-muted-foreground">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-3.5 w-6 items-center rounded-full transition-colors ${
          checked ? "bg-blue-500" : "bg-gray-300"
        }`}
      >
        <span
          className={`inline-block h-2.5 w-2.5 transform rounded-full bg-white transition-transform ${
            checked ? "translate-x-3" : "translate-x-0.5"
          }`}
        />
      </button>
    </label>
  );
}
