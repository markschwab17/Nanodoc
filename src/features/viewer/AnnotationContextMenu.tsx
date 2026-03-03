/**
 * AnnotationContextMenu Component
 *
 * A custom context menu for annotation right-click actions.
 * Renders a positioned overlay with action items.
 */

import { useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  separator?: boolean;
}

export interface AnnotationContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  items: ContextMenuItem[];
}

export function AnnotationContextMenu({ x, y, onClose, items }: AnnotationContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Adjust position to keep menu within viewport
  const getAdjustedPosition = useCallback(() => {
    const menu = menuRef.current;
    if (!menu) return { left: x, top: y };

    const rect = menu.getBoundingClientRect();
    const padding = 8;

    let left = x;
    let top = y;

    if (x + rect.width > window.innerWidth - padding) {
      left = x - rect.width;
    }
    if (y + rect.height > window.innerHeight - padding) {
      top = y - rect.height;
    }

    // Clamp to viewport
    left = Math.max(padding, left);
    top = Math.max(padding, top);

    return { left, top };
  }, [x, y]);

  // Close on click outside
  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }

    // Use a microtask so the triggering right-click doesn't immediately close the menu
    queueMicrotask(() => {
      document.addEventListener("pointerdown", handlePointerDown);
      document.addEventListener("keydown", handleKeyDown);
    });

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  // Reposition after mount to stay in viewport
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;

    const { left, top } = getAdjustedPosition();
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }, [getAdjustedPosition]);

  return (
    <div
      ref={menuRef}
      className={cn(
        "fixed z-50 min-w-[180px] overflow-hidden rounded-md border border-border",
        "bg-popover text-popover-foreground shadow-md",
        "animate-in fade-in-0 zoom-in-95 py-1"
      )}
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, index) => {
        if (item.separator) {
          return (
            <div
              key={`sep-${index}`}
              className="my-1 h-px bg-border"
            />
          );
        }

        return (
          <button
            key={item.label}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-sm",
              "outline-none transition-colors",
              item.disabled
                ? "cursor-default text-muted-foreground opacity-50"
                : "cursor-default hover:bg-accent hover:text-accent-foreground"
            )}
            disabled={item.disabled}
            onClick={() => {
              item.onClick();
              onClose();
            }}
          >
            {item.icon && (
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {item.icon}
              </span>
            )}
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
