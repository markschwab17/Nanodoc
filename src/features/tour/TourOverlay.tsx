/**
 * TourOverlay – spotlight overlay + tooltip card for guided tours.
 * Renders via portal; uses box-shadow for the spotlight cutout effect.
 */

import { useEffect, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useTourStore } from "@/shared/stores/tourStore";
import { TOUR_STEPS } from "./tourSteps";
import { Button } from "@/components/ui/button";

interface TourOverlayProps {
  tourId: string;
}

const SPOTLIGHT_PADDING = 8;
const TOOLTIP_GAP = 12;
const TOOLTIP_WIDTH = 320;

export function TourOverlay({ tourId }: TourOverlayProps) {
  const activeTourId = useTourStore((s) => s.activeTourId);
  const currentStepIndex = useTourStore((s) => s.currentStepIndex);
  const nextStep = useTourStore((s) => s.nextStep);
  const prevStep = useTourStore((s) => s.prevStep);
  const skipTour = useTourStore((s) => s.skipTour);
  const completeTour = useTourStore((s) => s.completeTour);

  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const rafRef = useRef<number>(0);

  const steps = TOUR_STEPS[tourId];
  if (!steps) return null;

  const isActive = activeTourId === tourId;
  const step = isActive ? steps[currentStepIndex] : null;
  const isLastStep = currentStepIndex >= steps.length - 1;

  const updateRect = useCallback(() => {
    if (!step) return;
    const el = document.querySelector(`[data-tour="${step.target}"]`);
    if (el) {
      setTargetRect(el.getBoundingClientRect());
    } else {
      setTargetRect(null);
    }
  }, [step]);

  // Track target element position
  useEffect(() => {
    if (!isActive || !step) return;

    updateRect();

    // Observe resize changes
    const el = document.querySelector(`[data-tour="${step.target}"]`);
    if (el) {
      observerRef.current = new ResizeObserver(() => updateRect());
      observerRef.current.observe(el);
    }

    // Track scroll / resize
    const handleScroll = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(updateRect);
    };
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);

    return () => {
      observerRef.current?.disconnect();
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
      cancelAnimationFrame(rafRef.current);
    };
  }, [isActive, step, updateRect]);

  // Keyboard navigation
  useEffect(() => {
    if (!isActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        skipTour();
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        if (isLastStep) completeTour();
        else nextStep();
      } else if (e.key === "ArrowLeft") {
        prevStep();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isActive, isLastStep, nextStep, prevStep, skipTour, completeTour]);

  if (!isActive || !step) return null;

  // Compute tooltip position
  const tooltipStyle = computeTooltipPosition(targetRect, step.placement);

  return createPortal(
    <div className="fixed inset-0 z-[9999]" aria-live="polite">
      {/* Spotlight overlay */}
      {targetRect ? (
        <div
          className="absolute rounded-lg pointer-events-none"
          style={{
            left: targetRect.left - SPOTLIGHT_PADDING,
            top: targetRect.top - SPOTLIGHT_PADDING,
            width: targetRect.width + SPOTLIGHT_PADDING * 2,
            height: targetRect.height + SPOTLIGHT_PADDING * 2,
            boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.5)",
            zIndex: 1,
          }}
        />
      ) : (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ backgroundColor: "rgba(0, 0, 0, 0.5)" }}
        />
      )}

      {/* Click-blocker behind tooltip (dismiss on click) */}
      <div
        className="absolute inset-0"
        style={{ zIndex: 2 }}
        onClick={skipTour}
      />

      {/* Tooltip card */}
      <div
        className="absolute bg-popover border border-border rounded-xl shadow-xl p-4 animate-in fade-in-0 zoom-in-95 duration-200"
        style={{
          ...tooltipStyle,
          width: TOOLTIP_WIDTH,
          zIndex: 3,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-1">
          <h3 className="font-semibold text-sm text-foreground">{step.title}</h3>
          <span className="text-xs text-muted-foreground whitespace-nowrap ml-2">
            {currentStepIndex + 1} / {steps.length}
          </span>
        </div>
        <p className="text-sm text-muted-foreground mb-4 leading-relaxed">
          {step.description}
        </p>
        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs h-7 px-2"
            onClick={skipTour}
          >
            Skip tour
          </Button>
          <div className="flex items-center gap-1.5">
            {currentStepIndex > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="text-xs h-7 px-3"
                onClick={prevStep}
              >
                Back
              </Button>
            )}
            <Button
              size="sm"
              className="text-xs h-7 px-3"
              onClick={isLastStep ? completeTour : nextStep}
            >
              {isLastStep ? "Finish" : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

function computeTooltipPosition(
  rect: DOMRect | null,
  placement: "top" | "bottom" | "left" | "right"
): React.CSSProperties {
  if (!rect) {
    // Center on screen when target not found
    return {
      left: "50%",
      top: "50%",
      transform: "translate(-50%, -50%)",
    };
  }

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left: number;
  let top: number;

  switch (placement) {
    case "bottom":
      left = rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2;
      top = rect.bottom + SPOTLIGHT_PADDING + TOOLTIP_GAP;
      break;
    case "top":
      left = rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2;
      top = rect.top - SPOTLIGHT_PADDING - TOOLTIP_GAP;
      break;
    case "left":
      left = rect.left - SPOTLIGHT_PADDING - TOOLTIP_GAP - TOOLTIP_WIDTH;
      top = rect.top + rect.height / 2;
      break;
    case "right":
      left = rect.right + SPOTLIGHT_PADDING + TOOLTIP_GAP;
      top = rect.top + rect.height / 2;
      break;
  }

  // For top placement, position from the bottom of the tooltip
  if (placement === "top") {
    // We don't know tooltip height yet, so use transform
    return {
      left: Math.max(8, Math.min(left, vw - TOOLTIP_WIDTH - 8)),
      top,
      transform: "translateY(-100%)",
    };
  }

  // For left/right, center vertically on the target
  if (placement === "left" || placement === "right") {
    return {
      left: Math.max(8, Math.min(left, vw - TOOLTIP_WIDTH - 8)),
      top: Math.max(8, Math.min(top, vh - 200)),
      transform: "translateY(-50%)",
    };
  }

  // Bottom - no transform needed, just clamp
  return {
    left: Math.max(8, Math.min(left, vw - TOOLTIP_WIDTH - 8)),
    top: Math.min(top, vh - 200),
  };
}
