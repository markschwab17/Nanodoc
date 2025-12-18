/**
 * Tab Item Component
 * 
 * Individual tab item in the tab bar with rename functionality.
 */

import { X, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Tab } from "@/shared/stores/tabStore";
import { useState, useRef, useEffect } from "react";

interface TabItemProps {
  tab: Tab;
  isActive: boolean;
  onClick: () => void;
  onClose: () => void;
  onRename?: (newName: string) => void;
  onDragStart?: (e: React.DragEvent, tabId: string) => void;
  onDragEnd?: () => void;
}

export function TabItem({ tab, isActive, onClick, onClose, onRename, onDragStart, onDragEnd }: TabItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(tab.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();
  };

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsEditing(true);
    setEditValue(tab.name);
  };

  const handleSave = () => {
    const trimmedValue = editValue.trim();
    if (trimmedValue && trimmedValue !== tab.name) {
      if (onRename) {
        onRename(trimmedValue);
      }
    } else {
      setEditValue(tab.name);
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditValue(tab.name);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
  };

  const handleTabClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isEditing) {
      onClick();
    }
  };

  const handleDragStartInternal = (e: React.DragEvent) => {
    // Use "all" to allow both move (reordering) and copy (inserting pages)
    e.dataTransfer.effectAllowed = "all";
    e.dataTransfer.setData("application/x-tab-id", tab.id);
    e.dataTransfer.setData("application/x-tab-document-id", tab.documentId);
    e.dataTransfer.setData("text/plain", tab.name);
    if (onDragStart) {
      onDragStart(e, tab.id);
    }
  };

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-2 py-1 border-b-2 cursor-pointer transition-colors rounded-t group",
        isActive
          ? "border-primary bg-background"
          : "border-transparent bg-muted/30 hover:bg-muted/50"
      )}
      onClick={handleTabClick}
      draggable
      onDragStart={handleDragStartInternal}
      onDragEnd={onDragEnd}
    >
      {isEditing ? (
        <Input
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleSave}
          onKeyDown={handleKeyDown}
          className="h-6 text-xs px-1.5 max-w-[150px]"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <>
          <span
            className={cn(
              "text-xs truncate max-w-[150px]",
              isActive ? "font-medium" : "text-muted-foreground"
            )}
          >
            {tab.name}
            {tab.isModified && <span className="ml-1">*</span>}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-4 w-4 opacity-0 group-hover:opacity-70 hover:opacity-100 transition-opacity"
            onClick={handleEdit}
            title="Rename"
          >
            <Pencil className="h-2.5 w-2.5" />
          </Button>
        </>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-4 w-4 opacity-70 hover:opacity-100"
        onClick={handleClose}
        title="Close"
      >
        <X className="h-2.5 w-2.5" />
      </Button>
    </div>
  );
}








