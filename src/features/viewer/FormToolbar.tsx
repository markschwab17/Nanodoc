/**
 * Form Toolbar Component
 *
 * Toolbar for form field tool settings
 */

import { useUIStore } from "@/shared/stores/uiStore";
import { cn } from "@/lib/utils";
import { Type, CheckSquare, Circle, ChevronDown, Calendar, Hash, AtSign, PenLine, List } from "lucide-react";

type FieldType = "text" | "checkbox" | "radio" | "dropdown" | "date" | "number" | "email" | "signature" | "listbox";

const fieldTypes: { type: FieldType; label: string; icon: React.ReactNode }[] = [
  { type: "text", label: "Text", icon: <Type className="h-3 w-3" /> },
  { type: "number", label: "Num", icon: <Hash className="h-3 w-3" /> },
  { type: "email", label: "Email", icon: <AtSign className="h-3 w-3" /> },
  { type: "checkbox", label: "Check", icon: <CheckSquare className="h-3 w-3" /> },
  { type: "radio", label: "Radio", icon: <Circle className="h-3 w-3" /> },
  { type: "dropdown", label: "Select", icon: <ChevronDown className="h-3 w-3" /> },
  { type: "listbox", label: "List", icon: <List className="h-3 w-3" /> },
  { type: "date", label: "Date", icon: <Calendar className="h-3 w-3" /> },
  { type: "signature", label: "Sign", icon: <PenLine className="h-3 w-3" /> },
];

export function FormToolbar() {
  const { currentFieldType, setCurrentFieldType } = useUIStore();

  return (
    <div className="flex items-center gap-0.5 px-1.5 py-1 flex-wrap">
      {fieldTypes.map(({ type, label, icon }) => (
        <button
          key={type}
          onClick={() => setCurrentFieldType(type)}
          className={cn(
            "flex items-center gap-1 px-2 py-0.5 text-xs rounded transition-colors",
            currentFieldType === type
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
          title={`Create ${label} field`}
        >
          {icon}
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
