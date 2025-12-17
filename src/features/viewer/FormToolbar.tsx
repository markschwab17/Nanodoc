/**
 * Form Toolbar Component
 * 
 * Toolbar for form field tool settings
 */

import { useUIStore } from "@/shared/stores/uiStore";
import { cn } from "@/lib/utils";
import { Type, CheckSquare, Circle, ChevronDown, Calendar } from "lucide-react";

type FieldType = "text" | "checkbox" | "radio" | "dropdown" | "date";

const fieldTypes: { type: FieldType; label: string; icon: React.ReactNode }[] = [
  { type: "text", label: "Text", icon: <Type className="h-4 w-4" /> },
  { type: "checkbox", label: "Checkbox", icon: <CheckSquare className="h-4 w-4" /> },
  { type: "radio", label: "Radio", icon: <Circle className="h-4 w-4" /> },
  { type: "dropdown", label: "Dropdown", icon: <ChevronDown className="h-4 w-4" /> },
  { type: "date", label: "Date", icon: <Calendar className="h-4 w-4" /> },
];

export function FormToolbar() {
  const { currentFieldType, setCurrentFieldType } = useUIStore();

  return (
    <div className="flex items-center gap-1 p-2">
      {fieldTypes.map(({ type, label, icon }) => (
        <button
          key={type}
          onClick={() => setCurrentFieldType(type)}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md transition-colors",
            currentFieldType === type
              ? "bg-primary text-primary-foreground"
              : "bg-muted/50 hover:bg-muted text-foreground"
          )}
          title={`Create ${label} field`}
        >
          {icon}
          <span>{label}</span>
        </button>
      ))}
      
      <span className="text-xs text-muted-foreground ml-3">
        Click and drag to place
      </span>
    </div>
  );
}

