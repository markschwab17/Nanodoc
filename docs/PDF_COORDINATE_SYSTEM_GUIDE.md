# PDF Coordinate System & Canvas Integration Guide

## Overview

This guide explains how to properly map mouse interactions to PDF coordinates and render overlays that align correctly with PDF content. This is critical for tools like redaction, highlighting, text boxes, and any interactive PDF editing features.

---

## Understanding the Coordinate Systems

### 1. PDF Coordinate System
- **Origin**: Bottom-left corner (0, 0)
- **Y-axis**: Increases upward (bottom to top)
- **X-axis**: Increases rightward (left to right)
- **Units**: Points (1 point = 1/72 inch)

### 2. Canvas Coordinate System
- **Origin**: Top-left corner (0, 0)
- **Y-axis**: Increases downward (top to bottom)
- **X-axis**: Increases rightward (left to right)
- **Units**: Pixels
- **High-DPI**: Canvas backing buffer is `devicePixelRatio` times larger than display size for crisp rendering

### 3. Screen/Mouse Coordinate System
- **Origin**: Browser viewport top-left
- **Y-axis**: Increases downward
- **X-axis**: Increases rightward
- **Units**: Pixels
- **Affected by**: Zoom, pan, scroll, element positioning

---

## Key Principles

### ✅ DO:
1. **Use `canvas.getBoundingClientRect()`** to get the canvas's actual screen position (accounts for all CSS transforms automatically)
2. **Store coordinates in PDF space** for annotations (y = bottom edge for rectangles)
3. **Use canvas coordinates for rendering previews** (simpler, matches text box behavior)
4. **Keep conversions symmetrical** (forward and reverse should mirror each other)

### ❌ DON'T:
1. **Don't manually calculate zoom/pan transforms** - use `getBoundingClientRect()` instead
2. **Don't use container coordinates** for mouse events - use canvas coordinates
3. **Don't mix coordinate systems** - convert once at boundaries
4. **Don't forget the Y-axis flip** between PDF and canvas

---

## High-DPI Rendering

The canvas uses high-DPI rendering for crisp text on Retina/HiDPI displays:

- **Canvas backing buffer**: `pageWidth * dpr` × `pageHeight * dpr` pixels
- **Canvas display size (CSS)**: `pageWidth` × `pageHeight` pixels
- **Result**: Browser downscales the high-res buffer for crisp rendering

**Important**: High-DPI affects the canvas backing buffer but NOT overlay positioning:
- `getPDFCoordinates()` accounts for dpr when converting canvas pixels → PDF
- `pdfToCanvas()` returns CSS coordinates (no dpr adjustment needed)
- Overlays (selection boxes, text editors, images) are positioned in CSS space

---

## The Conversion Pipeline

### Mouse → PDF (Capturing User Input)

```typescript
const getPDFCoordinates = (e: React.MouseEvent): { x: number; y: number } | null => {
  const canvasElement = canvasRef.current;
  const pageMetadata = document.getPageMetadata(pageNumber);
  
  if (!canvasElement || !pageMetadata) return null;
  
  // Step 1: Get canvas position on screen (accounts for ALL transforms)
  const canvasRect = canvasElement.getBoundingClientRect();
  
  // Step 2: Calculate mouse position relative to canvas element
  const canvasRelativeX = e.clientX - canvasRect.left;
  const canvasRelativeY = e.clientY - canvasRect.top;
  
  // Step 3: Convert from canvas screen size to canvas pixel coordinates
  // (canvas backing buffer may be larger than display size for high-DPI)
  const canvasPixelX = (canvasRelativeX / canvasRect.width) * canvasElement.width;
  const canvasPixelY = (canvasRelativeY / canvasRect.height) * canvasElement.height;
  
  // Step 4: Convert canvas pixels to PDF coordinates
  // High-DPI: divide by (BASE_SCALE * dpr) since backing buffer is dpr times larger
  const dpr = window.devicePixelRatio || 1;
  const pdfX = canvasPixelX / (BASE_SCALE * dpr);
  const pdfY = pageMetadata.height - (canvasPixelY / (BASE_SCALE * dpr));
  
  return { x: pdfX, y: pdfY };
};
```

**Why this works:**
- `getBoundingClientRect()` returns the canvas's actual rendered position/size on screen
- This automatically accounts for CSS transforms (scale, translate, etc.)
- We scale from screen coordinates → canvas pixels → PDF points
- The dpr adjustment accounts for the high-DPI backing buffer

### PDF → Canvas (Rendering Overlays)

```typescript
const pdfToCanvas = (pdfX: number, pdfY: number): { x: number; y: number } => {
  const pageMetadata = document.getPageMetadata(pageNumber);
  
  if (!pageMetadata) {
    return { x: pdfX * BASE_SCALE, y: pdfY * BASE_SCALE };
  }
  
  // PDF Y=0 is at bottom, canvas Y=0 is at top
  // Flip Y coordinate
  const flippedY = pageMetadata.height - pdfY;
  
  // Convert PDF points to CSS pixels for overlay positioning
  // Note: No dpr adjustment needed - overlays are positioned in CSS space,
  // not canvas backing buffer space
  return {
    x: pdfX * BASE_SCALE,
    y: flippedY * BASE_SCALE,
  };
};
```

**Why this works:**
- Flips Y-axis to convert from PDF (bottom-origin) to canvas (top-origin)
- Returns CSS coordinates for overlay positioning (not canvas backing pixels)
- Canvas is inside a transformed div, so CSS handles zoom/pan automatically
- High-DPI only affects the canvas backing buffer, not CSS positioning

---

## Practical Examples

### Example 1: Drawing a Selection Box (Redaction/Highlight)

```typescript
// On mouse down - capture start position
const handleMouseDown = (e: React.MouseEvent) => {
  if (activeTool === "redact") {
    const coords = getPDFCoordinates(e);  // Mouse → PDF
    if (coords) {
      setSelectionStart(coords);  // Store in PDF space
      setSelectionEnd(coords);
    }
  }
};

// On mouse move - update end position
const handleMouseMove = (e: React.MouseEvent) => {
  if (isSelecting) {
    const coords = getPDFCoordinates(e);  // Mouse → PDF
    if (coords) {
      setSelectionEnd(coords);  // Store in PDF space
    }
  }
};

// Render the preview box
{isSelecting && selectionStart && selectionEnd && (
  (() => {
    // Convert PDF → Canvas for rendering
    const startCanvas = pdfToCanvas(selectionStart.x, selectionStart.y);
    const endCanvas = pdfToCanvas(selectionEnd.x, selectionEnd.y);
    
    const minX = Math.min(startCanvas.x, endCanvas.x);
    const minY = Math.min(startCanvas.y, endCanvas.y);
    const width = Math.abs(endCanvas.x - startCanvas.x);
    const height = Math.abs(endCanvas.y - startCanvas.y);
    
    return (
      <div
        className="absolute border-2 border-red-500 bg-red-400/20"
        style={{
          left: `${minX}px`,
          top: `${minY}px`,
          width: `${width}px`,
          height: `${height}px`,
        }}
      />
    );
  })()
)}
```

**Key Points:**
- Store coordinates in **PDF space** (for annotation data)
- Render using **canvas space** (for preview overlay)
- The parent div has CSS transforms that handle zoom/pan automatically

### Example 2: Creating an Annotation from Selection

```typescript
// On mouse up - create annotation
const handleMouseUp = () => {
  if (isSelecting && selectionStart && selectionEnd) {
    // Calculate bounding box in PDF coordinates
    const minX = Math.min(selectionStart.x, selectionEnd.x);
    const minY = Math.min(selectionStart.y, selectionEnd.y);  // Bottom edge
    const maxX = Math.max(selectionStart.x, selectionEnd.x);
    const maxY = Math.max(selectionStart.y, selectionEnd.y);  // Top edge
    
    const annotation = {
      id: `redact_${Date.now()}`,
      type: "redact",
      pageNumber,
      x: minX,        // Left edge
      y: minY,        // Bottom edge (PDF Y=0 at bottom)
      width: maxX - minX,
      height: maxY - minY,
    };
    
    // Create PDF annotation with these coordinates
    const rect: [number, number, number, number] = [
      annotation.x,                    // x0 (bottom-left X)
      annotation.y,                    // y0 (bottom-left Y)
      annotation.x + annotation.width, // x1 (top-right X)
      annotation.y + annotation.height // y1 (top-right Y)
    ];
    
    const annot = page.createAnnotation("Redact");
    annot.setRect(rect);
    annot.update();
  }
};
```

**Key Points:**
- In PDF space, `minY` = bottom edge, `maxY` = top edge
- PDF rect format: `[x0, y0, x1, y1]` where (x0,y0) is bottom-left
- Store `y` as the bottom edge for consistency with mupdf

### Example 3: Rendering Existing Annotations

```typescript
{annotations.map((annot) => {
  if (annot.type === "redact") {
    const redactWidth = annot.width || 100;
    const redactHeight = annot.height || 50;
    
    // annot.y is the BOTTOM edge in PDF
    // For canvas rendering, we need the TOP edge
    const pdfTopY = annot.y + redactHeight;
    
    // Convert to canvas coordinates
    const canvasPos = pdfToCanvas(annot.x, pdfTopY);
    const canvasWidth = redactWidth * BASE_SCALE;
    const canvasHeight = redactHeight * BASE_SCALE;
    
    return (
      <div
        key={annot.id}
        className="absolute bg-black"
        style={{
          left: `${canvasPos.x}px`,
          top: `${canvasPos.y}px`,
          width: `${canvasWidth}px`,
          height: `${canvasHeight}px`,
        }}
      />
    );
  }
})}
```

**Key Points:**
- Annotation stores `y` as bottom edge (PDF convention)
- Add height to get top edge: `pdfTopY = annot.y + annot.height`
- Convert top-left corner to canvas for rendering
- CSS transforms handle zoom/pan automatically

---

## Common Pitfalls & Solutions

### Problem 1: Preview Box in Wrong Location
**Symptom**: Selection box appears far from where you're clicking

**Cause**: Using `pdfToContainer()` with manual zoom/pan calculations instead of `pdfToCanvas()`

**Solution**: Use `pdfToCanvas()` for preview rendering (matches text box behavior)

```typescript
// ❌ WRONG - manual transform calculations
const startContainer = pdfToContainer(selectionStart.x, selectionStart.y);

// ✅ CORRECT - use canvas coordinates
const startCanvas = pdfToCanvas(selectionStart.x, selectionStart.y);
```

### Problem 2: Annotation Not Where Expected After Save/Reload
**Symptom**: Annotation appears in wrong location after saving and reopening PDF

**Cause**: Not accounting for PDF's bottom-left origin when creating rect

**Solution**: Ensure rect uses (x, y) as bottom-left corner

```typescript
// ❌ WRONG - treats y as top edge
const rect = [x, y, x + width, y + height];  // If y is top edge

// ✅ CORRECT - y is bottom edge
const rect = [x, y, x + width, y + height];  // If y is bottom edge (PDF convention)
```

### Problem 3: Vertical Position Inverted
**Symptom**: Selection box appears flipped vertically

**Cause**: Not flipping Y-axis when converting between PDF and canvas

**Solution**: Always flip Y using page height

```typescript
// PDF → Canvas
const canvasY = pageHeight - pdfY;

// Canvas → PDF
const pdfY = pageHeight - canvasY;
```

### Problem 4: Coordinates Change with Zoom
**Symptom**: Coordinates seem correct at 100% zoom but wrong at other zoom levels

**Cause**: Using zoom in coordinate conversion instead of letting CSS handle it

**Solution**: Store in PDF space, render in canvas space, let CSS transforms handle zoom

```typescript
// ✅ CORRECT - CSS transform handles zoom
<div style={{
  transform: `scale(${zoomLevel}) translate(${pan.x / zoomLevel}px, ${pan.y / zoomLevel}px)`,
  transformOrigin: "0 0"
}}>
  {/* Overlays positioned in canvas pixels - CSS transform handles the rest */}
</div>
```

---

## Testing Checklist

When implementing a new tool that interacts with PDF coordinates:

- [ ] Preview box appears exactly where you're selecting
- [ ] Works at 100% zoom
- [ ] Works at 50% zoom  
- [ ] Works at 200% zoom
- [ ] Works when panned (moved around)
- [ ] Works after page rotation
- [ ] Annotation loads correctly after save/reload
- [ ] Works on different page sizes
- [ ] Works in both read mode and edit mode

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Mouse Event (Screen Coordinates)                           │
│  e.clientX, e.clientY                                        │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      │ getPDFCoordinates(e)
                      │ • Get canvas.getBoundingClientRect()
                      │ • Calculate relative to canvas
                      │ • Scale screen → canvas pixels
                      │ • Flip Y-axis
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  PDF Coordinates (Annotation Storage)                       │
│  { x: pdfX, y: pdfY }                                        │
│  • Origin: bottom-left                                       │
│  • Y increases upward                                        │
│  • Stored in annotation objects                             │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      │ pdfToCanvas(pdfX, pdfY)
                      │ • Flip Y-axis
                      │ • Scale PDF points → canvas pixels
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  Canvas Coordinates (Rendering)                              │
│  { x: canvasX, y: canvasY }                                  │
│  • Origin: top-left                                          │
│  • Y increases downward                                      │
│  • Position overlays using canvas pixels                    │
│  • CSS transforms handle zoom/pan                           │
└─────────────────────────────────────────────────────────────┘
```

---

## Real-World Example: Redaction Tool

### The Problem We Solved

**Initial Issue**: 
- Preview box appeared far from mouse cursor
- Redaction applied to wrong location
- Used complex manual zoom/pan calculations

**Root Cause**:
- Mixed coordinate systems (container vs canvas)
- Incorrect use of transforms
- `pdfToContainer()` tried to manually apply zoom/pan

**The Fix**:
- Use `canvas.getBoundingClientRect()` for accurate screen position
- Store in PDF space, render in canvas space
- Let CSS transforms handle zoom/pan automatically

### Working Code

```typescript
// 1. Convert mouse to PDF (for storage)
const getPDFCoordinates = (e: React.MouseEvent) => {
  const canvasElement = canvasRef.current;
  const canvasRect = canvasElement.getBoundingClientRect();
  
  // Mouse relative to canvas
  const canvasRelativeX = e.clientX - canvasRect.left;
  const canvasRelativeY = e.clientY - canvasRect.top;
  
  // Scale to canvas pixels (backing buffer may be larger for high-DPI)
  const canvasPixelX = (canvasRelativeX / canvasRect.width) * canvasElement.width;
  const canvasPixelY = (canvasRelativeY / canvasRect.height) * canvasElement.height;
  
  // Convert to PDF (flip Y, account for high-DPI backing buffer)
  const dpr = window.devicePixelRatio || 1;
  const pdfX = canvasPixelX / (BASE_SCALE * dpr);
  const pdfY = pageMetadata.height - (canvasPixelY / (BASE_SCALE * dpr));
  
  return { x: pdfX, y: pdfY };
};

// 2. Convert PDF to canvas CSS coordinates (for rendering overlays)
const pdfToCanvas = (pdfX: number, pdfY: number) => {
  const flippedY = pageMetadata.height - pdfY;  // Flip Y
  
  // Returns CSS coordinates (no dpr adjustment - overlays in CSS space)
  return {
    x: pdfX * BASE_SCALE,
    y: flippedY * BASE_SCALE,
  };
};

// 3. Render preview (follows mouse exactly)
{isSelecting && selectionStart && selectionEnd && (
  (() => {
    // Use pdfToCanvas (NOT pdfToContainer)
    const startCanvas = pdfToCanvas(selectionStart.x, selectionStart.y);
    const endCanvas = pdfToCanvas(selectionEnd.x, selectionEnd.y);
    
    const minX = Math.min(startCanvas.x, endCanvas.x);
    const minY = Math.min(startCanvas.y, endCanvas.y);
    const width = Math.abs(endCanvas.x - startCanvas.x);
    const height = Math.abs(endCanvas.y - startCanvas.y);
    
    return (
      <div
        style={{
          position: "absolute",
          left: `${minX}px`,
          top: `${minY}px`,
          width: `${width}px`,
          height: `${height}px`,
        }}
      />
    );
  })()
)}

// 4. Create annotation (store in PDF space)
const annotation = {
  x: Math.min(selectionStart.x, selectionEnd.x),      // Left edge
  y: Math.min(selectionStart.y, selectionEnd.y),      // Bottom edge
  width: Math.abs(selectionEnd.x - selectionStart.x),
  height: Math.abs(selectionEnd.y - selectionStart.y),
};

// 5. Create mupdf annotation
const rect: [number, number, number, number] = [
  annotation.x,                    // x0 (bottom-left X)
  annotation.y,                    // y0 (bottom-left Y)  
  annotation.x + annotation.width, // x1 (top-right X)
  annotation.y + annotation.height // y1 (top-right Y)
];
```

---

## Debugging Tips

### Add Logging to Track Conversions

```typescript
console.log("🎯 Coordinate conversion:");
console.log("  Mouse screen:", { x: e.clientX, y: e.clientY });
console.log("  Canvas rect:", canvasRect);
console.log("  Canvas relative:", { canvasRelativeX, canvasRelativeY });
console.log("  Canvas pixels:", { canvasPixelX, canvasPixelY });
console.log("  PDF coords:", { pdfX, pdfY });
```

### Visual Debugging

Add a small dot at the exact click position to verify alignment:

```typescript
<div
  style={{
    position: "absolute",
    left: `${canvasX - 5}px`,
    top: `${canvasY - 5}px`,
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    background: "red",
    pointerEvents: "none",
    zIndex: 9999,
  }}
/>
```

### Sanity Checks

1. **Canvas pixels should be ≤ canvas dimensions**:
   - If `canvasPixelX > canvas.width`, something is wrong
   
2. **PDF coordinates should be ≤ page dimensions**:
   - If `pdfX > pageMetadata.width`, coordinates are off

3. **Preview should follow mouse 1:1**:
   - If preview lags or jumps, check getBoundingClientRect() usage

---

## Reference: Text Box Tool (Known Working Example)

The text box tool preview uses this exact pattern and works correctly:

```typescript
{isCreatingTextBox && textBoxStart && selectionEnd && activeTool === "text" && (
  (() => {
    // ✅ Uses pdfToCanvas - this is the correct approach
    const startCanvas = pdfToCanvas(textBoxStart.x, textBoxStart.y);
    const endCanvas = pdfToCanvas(selectionEnd.x, selectionEnd.y);
    const minX = Math.min(startCanvas.x, endCanvas.x);
    const minY = Math.min(startCanvas.y, endCanvas.y);
    const width = Math.abs(endCanvas.x - startCanvas.x);
    const height = Math.abs(endCanvas.y - startCanvas.y);
    
    return (
      <div
        className="absolute border-2 border-dashed border-primary bg-primary/10"
        style={{
          left: `${minX}px`,
          top: `${minY}px`,
          width: `${Math.max(50, width)}px`,
          height: `${Math.max(30, height)}px`,
        }}
      />
    );
  })()
)}
```

**Follow this pattern for all new tools!**

---

## Summary

### The Golden Rule

**Store coordinates in PDF space, render in canvas space, let CSS handle transforms.**

### Quick Reference

| Operation | Method | Purpose |
|-----------|--------|---------|
| Mouse → PDF | `getPDFCoordinates(e)` | Capture user input |
| PDF → Canvas | `pdfToCanvas(x, y)` | Render overlays |
| Preview boxes | Use `pdfToCanvas()` | Matches mouse position |
| Stored annotations | Use PDF coordinates | Consistent with mupdf |
| Y-axis flip | `pageHeight - y` | Convert between systems |

### Key Files

- `src/features/viewer/PageCanvas.tsx` - Contains coordinate conversion functions
- `src/core/pdf/PDFEditor.ts` - Uses PDF coordinates for mupdf API
- Text box preview (lines ~1222-1244) - Reference implementation

---

## Last Updated

December 2025 - Added high-DPI rendering support for crisp text on Retina/HiDPI displays

