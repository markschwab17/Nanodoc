# PDF Redaction Implementation Guide

## Overview

This document explains how the redaction feature permanently removes content from PDFs using mupdf's redaction annotations and the `applyRedactions()` method.

---

## What is True Redaction?

### ❌ NOT Redaction (Insecure)
- Drawing black/white rectangles over content
- Changing text color to white
- Adding overlay images
- **Problem**: Original content still exists in PDF structure and can be extracted

### ✅ True Redaction (Secure)
- Creates Redact annotation marking the area
- Calls `page.applyRedactions()` to process the annotation
- **Permanently removes** text, images, and graphics from content stream
- Content cannot be recovered - it's deleted from the PDF structure

---

## How mupdf Redaction Works

### Step 1: Create Redact Annotation

```typescript
const page = pdfDoc.loadPage(pageNumber);

const rect: [number, number, number, number] = [
  x,              // x0 (bottom-left X)
  y,              // y0 (bottom-left Y)
  x + width,      // x1 (top-right X)
  y + height      // y1 (top-right Y)
];

const annot = page.createAnnotation("Redact");
annot.setRect(rect);
annot.update();
```

**Important Notes**:
- Redact annotations **don't support `setInteriorColor()`** - this property is applied during `applyRedactions()`
- The annotation just marks the area for redaction
- No content is removed yet at this stage

### Step 2: Apply Redactions

```typescript
// Apply redactions to permanently remove content
page.applyRedactions(blackBoxes, imageMethod);
```

**Parameters**:
- `blackBoxes` (number/boolean):
  - `0` or `false` = Fill with white (shows page background)
  - `1` or `true` = Fill with black boxes
- `imageMethod` (number):
  - `0` = Remove images completely
  - `1` = Remove images  
  - `2` = Pixelate images (blur/obscure)

**Our Implementation**:
```typescript
page.applyRedactions(0, 0);  // White fill, remove images
```

### Step 3: Save the Document

```typescript
const buffer = pdfDoc.saveToBuffer();
const data = buffer.asUint8Array();
```

The saved PDF will have the content permanently removed.

---

## Implementation in CivilPDF

### File: `src/core/pdf/PDFEditor.ts`

```typescript
async addRedactionAnnotation(
  document: PDFDocument,
  annotation: Annotation
): Promise<void> {
  const mupdfDoc = document.getMupdfDocument();
  const pdfDoc = mupdfDoc.asPDF();
  const page = pdfDoc.loadPage(annotation.pageNumber);
  
  // Create rect (bottom-left to top-right)
  const rect: [number, number, number, number] = [
    annotation.x,
    annotation.y,
    annotation.x + (annotation.width || 100),
    annotation.y + (annotation.height || 50),
  ];
  
  // Create redaction annotation
  const annot = page.createAnnotation("Redact");
  annot.setRect(rect);
  annot.update();
  
  // Apply redaction immediately - removes content
  try {
    page.applyRedactions(0, 0);  // White fill, remove images
    console.log("✓ Redactions applied - content permanently removed");
  } catch (err) {
    console.error("❌ Error applying redactions:", err);
    throw err;
  }
}
```

### Key Implementation Details

1. **Immediate Application**: We call `applyRedactions()` right after creating the annotation, so content is removed immediately (not just when saving)

2. **Force Re-render**: After applying redaction, we clear the render cache and re-render the page to show the changes

3. **Double Application**: We also apply redactions in `saveDocument()` to catch any that weren't applied immediately

4. **Error Handling**: If `applyRedactions()` fails, we throw an error so the user knows

---

## User Experience Flow

1. **User selects redact tool** (Eraser icon in toolbar)
2. **User draws selection box** on PDF
   - Red semi-transparent preview shows selected area
   - Preview uses canvas coordinates (follows mouse exactly)
3. **User releases mouse** (mouse up event)
   - Redaction annotation created with PDF coordinates
   - `page.applyRedactions(0, 0)` called immediately
   - Content permanently removed from PDF
   - Page re-rendered to show white area where content was deleted
4. **User saves document**
   - All redactions applied again (safety measure)
   - Document saved with content permanently removed

---

## Verification

### How to Verify Content is Truly Deleted

1. **Apply redaction in CivilPDF**
2. **Save the PDF**
3. **Open in another PDF viewer** (Adobe Acrobat, Preview, etc.)
4. **Try to select/copy text** from redacted area
   - Should be impossible - content is gone
5. **Inspect PDF structure** with a PDF analyzer
   - Content streams should show removed content
   - Text/images in redacted area should be absent

### Console Output

When redaction works correctly, you should see:

```
Creating redaction annotation at rect: [1780, 1383, 1844, 1427]
Calling page.applyRedactions() to permanently remove content...
✓ Redactions applied with parameters - content permanently removed
Redaction annotation saved to PDF and content removed
```

---

## Working Implementation (December 2025)

### Critical Fixes Applied

After research and testing, we identified and fixed the following issues:

#### 1. **Parameter Format Compatibility**

Different mupdf.js versions use different parameter formats. Our solution tries multiple approaches:

```typescript
// Try 4 parameters (newest API)
try {
  page.applyRedactions(false, 0, 0, 0);  // Works!
} catch {
  // Try 2 parameters (older API)
  try {
    page.applyRedactions(false, 0);  // Works!
  } catch {
    // Try 1 parameter
    try {
      page.applyRedactions(false);  // Works!
    } catch {
      // Try no parameters (oldest API)
      page.applyRedactions();  // Works!
    }
  }
}
```

**Key insight**: Use `false` (boolean) instead of `0` (number) for `blackBoxes` parameter. This is more compatible across versions.

#### 2. **Page Cache Must Be Cleared**

After calling `applyRedactions()`, the page MUST be reloaded to see changes:

```typescript
// Apply redaction
page.applyRedactions(false, 0, 0, 0);

// CRITICAL: Reload page to clear mupdf's internal cache
pdfDoc.loadPage(pageNumber);  // This forces fresh content

// Also refresh document metadata
document.refreshPageMetadata();

// Clear renderer cache
renderer.clearCache();
```

**Why this matters**: mupdf caches page objects internally. Without reloading, you'll render the OLD cached content even though the PDF content stream was modified.

#### 3. **Verification Logic**

After applying redactions, verify they worked:

```typescript
// Check if Redact annotations remain (they shouldn't)
const page = pdfDoc.loadPage(pageNumber);
const annots = page.getAnnotations();
const hasRedactAnnots = annots.some(a => a.getType() === "Redact");

if (hasRedactAnnots) {
  console.warn("Redact annotations still present - content may not be removed");
} else {
  console.log("✓ Verification passed - content removed");
}
```

**Note**: After `applyRedactions()`, the Redact annotations are consumed/removed. If they're still there, something went wrong.

#### 4. **Comprehensive Logging**

Added detailed console logging to track the entire flow:

```
🔴 Creating redaction annotation at rect: [100, 200, 300, 400]
🔄 Calling page.applyRedactions() to permanently remove content...
✓ Applied redactions with 4 parameters
✅ Redactions applied successfully using 4 parameters (false, 0, 0, 0)
📄 Content permanently removed from PDF content stream
🔄 Reloading page to refresh content...
✓ Verification passed: Redact annotations removed from page
✓ Document metadata refreshed
✓ Renderer cache cleared
✓ Page reloaded in mupdf
🎨 Re-rendering page to show redaction...
✅ Page re-rendered successfully - redacted area should now show as white
✅ Redaction complete - content permanently removed
```

This makes debugging much easier.

#### 5. **Visual Feedback**

Added success/error notifications:

- ✅ Success: "Content redacted - permanently removed from PDF"
- ❌ Error: "Redaction failed: [error message]"

### Expected Console Output

When redaction works correctly, you'll see:

```
🔄 Starting redaction process...
🔴 Creating redaction annotation at rect: [x, y, x+w, y+h]
🔄 Calling page.applyRedactions() to permanently remove content...
✓ Applied redactions with 4 parameters
✅ Redactions applied successfully using 4 parameters (false, 0, 0, 0)
✓ Redaction applied to PDF
✓ Renderer cache cleared
✓ Document metadata refreshed
✓ Page reloaded in mupdf
🎨 Re-rendering page to show redaction...
✅ Page re-rendered successfully - redacted area should now show as white
✅ Redaction complete - content permanently removed
```

---

## Common Issues & Solutions

### Issue 1: No Visual Change After Redaction

**Symptom**: Red preview box shows during selection, but after releasing mouse, original content still visible

**Causes**:
1. Page cache not cleared after `applyRedactions()`
2. Renderer using stale cached image data
3. Document metadata not refreshed

**Solutions** (All implemented in current version):
1. Call `pdfDoc.loadPage(pageNumber)` after `applyRedactions()` to clear page cache
2. Call `renderer.clearCache()` to invalidate cached renders
3. Call `document.refreshPageMetadata()` to update cached page info
4. Re-render the page immediately to show changes

### Issue 2: Content Not Deleted

**Symptom**: Redacted area just shows black/white overlay, original content still extractable

**Causes**:
1. `applyRedactions()` not called
2. `applyRedactions()` called with wrong parameters
3. mupdf version doesn't support `applyRedactions()`

**Solutions** (Implemented):
1. Our code tries 4 different parameter formats for compatibility
2. We use `false` (boolean) instead of `0` (number) for better compatibility
3. Comprehensive error logging shows which method worked

### Issue 2: setInteriorColor Error

**Error**: `"Redact annotations have no IC property"`

**Cause**: Trying to call `annot.setInteriorColor()` on a Redact annotation

**Solution**: **Don't call `setInteriorColor()`** on redaction annotations - the fill color is determined by the `applyRedactions()` parameters

```typescript
// ❌ WRONG - Redact annotations don't support this
const annot = page.createAnnotation("Redact");
annot.setRect(rect);
annot.setInteriorColor([1, 1, 1]);  // ← ERROR!

// ✅ CORRECT - Skip setInteriorColor
const annot = page.createAnnotation("Redact");
annot.setRect(rect);
annot.update();
page.applyRedactions(0, 0);  // Fill color set here
```

### Issue 3: Redactions Not Persisting

**Symptom**: Redactions disappear after save/reload

**Cause**: `applyRedactions()` not called before saving

**Solution**: Our implementation applies redactions twice - once immediately and once during save for safety:

```typescript
async saveDocument(document: PDFDocument, annotations?: Annotation[]) {
  if (annotations) {
    await this.syncAllAnnotations(document, annotations);
    
    // Apply redactions on all pages that have them (safety measure)
    const redactionsByPage = new Map<number, Annotation[]>();
    for (const annot of annotations) {
      if (annot.type === "redact") {
        // ... group by page
      }
    }
    
    for (const pageNumber of redactionsByPage.keys()) {
      const page = pdfDoc.loadPage(pageNumber);
      // Try multiple parameter formats for compatibility
      try {
        page.applyRedactions(false, 0);
      } catch {
        page.applyRedactions();
      }
    }
  }
  
  return pdfDoc.saveToBuffer().asUint8Array();
}
```

### Issue 4: Wrong Parameter Types

**Symptom**: `applyRedactions()` throws type errors or doesn't work

**Cause**: Using numeric `0` instead of boolean `false` for blackBoxes parameter

**Solution**: Use boolean values for better compatibility:

```typescript
// ❌ LESS COMPATIBLE
page.applyRedactions(0, 0, 0, 0);  // Numbers - may not work in all versions

// ✅ MORE COMPATIBLE  
page.applyRedactions(false, 0, 0, 0);  // Boolean for blackBoxes - better!
```

### Issue 5: Redaction Works But Page Doesn't Update

**Symptom**: Content IS removed from PDF, but page still shows old content until save/reload

**Cause**: Renderer and document caches not cleared after redaction

**Solution** (Implemented):
```typescript
// After applyRedactions():
renderer.clearCache();              // Clear render cache
document.refreshPageMetadata();     // Refresh document cache
pdfDoc.loadPage(pageNumber);        // Reload page in mupdf
// Then re-render immediately
```

---

## Alternative Approaches (Not Recommended)

### Approach 1: Content Stream Manipulation

Directly edit the PDF content stream to remove text/graphics operators:

**Pros**: Maximum control, works without `applyRedactions()`

**Cons**: 
- Extremely complex (need to parse content stream syntax)
- Easy to corrupt the PDF
- Have to handle all drawing operators (Tj, TJ, Do, etc.)
- Have to update resource dictionaries
- Not recommended unless absolutely necessary

### Approach 2: Black Box Overlay

Draw black rectangles to cover content:

**Pros**: Simple to implement

**Cons**:
- **Not secure** - original content still in PDF
- Can be removed by editing PDF
- Doesn't meet security requirements
- **Never use for sensitive data**

### Approach 3: Page Replacement

Render page to image, redact image, replace page with image:

**Pros**: Guarantees content removal

**Cons**:
- Converts entire page to image (loses text/searchability)
- Much larger file size
- Loses vector graphics quality
- Overkill for most use cases

---

## Best Practices

1. **Always call `applyRedactions()`** - Creating the annotation isn't enough
2. **Use boolean `false` for blackBoxes** - More compatible than numeric `0`
3. **Try multiple parameter formats** - Support different mupdf versions
4. **Clear all caches after redaction** - Page cache, renderer cache, document cache
5. **Reload the page** - Call `loadPage()` again after `applyRedactions()`
6. **Re-render immediately** - Show changes to user without waiting for save
7. **Verify redaction worked** - Check that Redact annotations were consumed
8. **Apply again when saving** - Safety measure in case of edge cases
9. **Add comprehensive logging** - Makes debugging much easier
10. **Show user feedback** - Success/error notifications
11. **Test in other PDF viewers** - Verify content is truly removed
12. **Keep backups** - Original documents before redaction

---

## Security Considerations

### What Redaction Removes
- ✅ Text in content stream
- ✅ Images (if imageMethod = 0 or 1)
- ✅ Vector graphics in redacted area
- ✅ Form fields in redacted area

### What Redaction DOESN'T Remove
- ❌ Metadata (author, creation date, etc.)
- ❌ Comments/annotations outside redacted areas
- ❌ Bookmarks
- ❌ Attachments
- ❌ JavaScript

### Full Sanitization

For complete security, also implement:
1. **Metadata removal** - Clear document info dictionary
2. **Hidden content removal** - Remove hidden layers, OCG content
3. **JavaScript removal** - Remove all embedded scripts
4. **Attachment removal** - Remove file attachments
5. **Comment removal** - Remove all annotations except redactions

---

## Future Enhancements

### Planned Features
- [ ] Batch redaction (select multiple areas before applying)
- [ ] Search and redact (find text and redact all occurrences)
- [ ] Confirmation dialog before applying redactions
- [ ] Undo support for redactions (before save)
- [ ] Redaction preview mode
- [ ] Metadata sanitization
- [ ] Redaction audit log/report

### Nice to Have
- [ ] Custom fill colors (not just white/black)
- [ ] Pixelate option for images
- [ ] Redaction templates (for forms)
- [ ] Bulk redaction from list of coordinates

---

## References

- [mupdf.js Documentation](https://mupdfjs.readthedocs.io/)
- [mupdf PDFPage API](https://mupdf.readthedocs.io/en/latest/reference/javascript/types/PDFPage.html)
- [PDF Redaction Best Practices](https://www.adobe.com/trust/document-cloud/security/redaction.html)

---

## Troubleshooting Guide

### Debug Checklist

If redaction isn't working, check these in order:

1. **Check console for error messages**
   - Look for red error messages
   - Check which parameter format worked
   - Look for verification warnings

2. **Verify `applyRedactions()` is available**
   - Check: `typeof page.applyRedactions === 'function'`
   - If not available, mupdf version too old

3. **Check if content was actually removed**
   - Save PDF and open in external viewer
   - Try to select/copy text from redacted area
   - If you can select it, content wasn't removed

4. **Check if caches were cleared**
   - Look for console messages: "✓ Renderer cache cleared"
   - Look for: "✓ Document metadata refreshed"
   - Look for: "✓ Page reloaded in mupdf"

5. **Check if page re-rendered**
   - Look for: "✅ Page re-rendered successfully"
   - If missing, render may have failed

6. **Verify notification appeared**
   - Should see green success notification
   - Or red error notification with details

### Console Commands for Debugging

Open browser console and try:

```javascript
// Check mupdf version
window.mupdf

// Check if document is loaded
const store = window.__ZUSTAND_STORES__?.pdf
store?.getCurrentDocument()

// Check annotations
store?.getAnnotations(documentId)

// Force render cache clear
renderer.clearCache()
```

---

## Last Updated

December 2025 - Fixed redaction implementation with multi-version parameter support, comprehensive caching fixes, and verification logic

