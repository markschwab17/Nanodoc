# PDF Editor Refactoring - Testing Checklist

This checklist covers all functionality that was refactored from the monolithic `PDFEditor.ts` into modular classes. Test each item to ensure the refactoring didn't break any functionality.

## ✅ Build Status
- [x] TypeScript compilation passes (`npx tsc --noEmit`)
- [x] No build errors
- [x] All imports resolve correctly

---

## 📄 Page Operations (PDFPageOperations.ts)

### 1. Page Reordering
**Test Location:** Thumbnail carousel drag-and-drop
- [ ] Drag a page thumbnail to reorder pages
- [ ] Reorder multiple pages in sequence
- [ ] Verify page numbers update correctly after reordering
- [ ] Verify annotations stay with their pages after reorder
- [ ] Test reordering first page, last page, and middle pages

**Code Path:** `editor.reorderPages(document, operations)`

### 2. Insert Blank Page
**Test Location:** Page Tools → Insert Page
- [ ] Insert blank page at the beginning (index 0)
- [ ] Insert blank page in the middle
- [ ] Insert blank page at the end
- [ ] Verify page dimensions are correct (default 612x792)
- [ ] Verify page count increases correctly

**Code Path:** `editor.insertBlankPage(document, index, width, height)`

### 3. Insert Pages from Another PDF
**Test Location:** Page Tools → Insert from PDF
- [ ] Insert all pages from another PDF
- [ ] Insert specific pages from another PDF
- [ ] Insert at different positions (beginning, middle, end)
- [ ] Verify source PDF pages are copied correctly
- [ ] Verify annotations from source PDF are preserved

**Code Path:** `editor.insertPagesFromDocument(targetDoc, sourceDoc, targetIndex, sourcePageIndices)`

### 4. Delete Pages
**Test Location:** Page Tools → Delete Page, Thumbnail carousel
- [ ] Delete a single page
- [ ] Delete multiple pages
- [ ] Delete first page
- [ ] Delete last page
- [ ] Delete consecutive pages
- [ ] Delete non-consecutive pages
- [ ] Verify page numbers update correctly after deletion
- [ ] Verify annotations on deleted pages are removed

**Code Path:** `editor.deletePages(document, pageIndices)`

### 5. Rotate Page
**Test Location:** Thumbnail carousel → Rotate button
- [ ] Rotate page 90 degrees clockwise
- [ ] Rotate page 180 degrees
- [ ] Rotate page 270 degrees
- [ ] Rotate multiple times (360+ degrees)
- [ ] Verify annotations rotate with the page
- [ ] Verify rotation persists after save/reload

**Code Path:** `editor.rotatePage(document, pageNumber, degrees)`

### 6. Resize Page
**Test Location:** Page Tools (if available)
- [ ] Resize a single page to different dimensions
- [ ] Verify content scales correctly
- [ ] Verify annotations scale correctly
- [ ] Test with different aspect ratios

**Code Path:** `editor.resizePage(document, pageNumber, width, height)`

### 7. Resize All Pages
**Test Location:** Page Tools (if available)
- [ ] Resize all pages to same dimensions
- [ ] Verify all pages resize uniformly
- [ ] Verify annotations on all pages scale correctly

**Code Path:** `editor.resizeAllPages(document, width, height)`

---

## ✏️ Annotation Operations (PDFAnnotationOperations.ts)

### 8. Add Text Annotation
**Test Location:** Text tool in toolbar
- [ ] Add text annotation at various positions
- [ ] Test different font sizes
- [ ] Test different font families
- [ ] Test text formatting (bold, italic, underline)
- [ ] Test text colors
- [ ] Test text with background
- [ ] Test text rotation
- [ ] Verify text appears correctly on PDF

**Code Path:** `editor.addTextAnnotation(document, annotation)`

### 9. Add Highlight Annotation
**Test Location:** Highlight tool in toolbar
- [ ] Highlight text by selecting it
- [ ] Highlight multiple text selections
- [ ] Test different highlight colors
- [ ] Test highlight opacity
- [ ] Test highlight modes (text vs overlay)
- [ ] Verify highlights persist after save/reload

**Code Path:** `editor.addHighlightAnnotation(document, annotation)`

### 10. Add Image Annotation
**Test Location:** Image annotation tool
- [ ] Add image annotation
- [ ] Test different image formats
- [ ] Test image scaling/preserving aspect ratio
- [ ] Test image positioning
- [ ] Verify image appears correctly on PDF

**Code Path:** `editor.addImageAnnotation(document, annotation)`

### 11. Add Callout Annotation
**Test Location:** Callout tool in toolbar
- [ ] Add callout annotation
- [ ] Test callout positioning
- [ ] Test callout text content
- [ ] Test callout arrow/line
- [ ] Verify callout appears correctly

**Code Path:** `editor.addCalloutAnnotation(document, annotation)`

### 12. Add Redaction Annotation
**Test Location:** Redaction tool in toolbar
- [ ] Add redaction annotation over text
- [ ] Add redaction annotation over images
- [ ] Test redaction on multiple areas
- [ ] Verify redaction is applied when flattening
- [ ] Verify redacted content is removed from PDF

**Code Path:** `editor.addRedactionAnnotation(document, annotation)`

### 13. Add Drawing Annotation
**Test Location:** Draw tool in toolbar
- [ ] Draw freehand lines
- [ ] Test different drawing styles (marker, pencil, pen)
- [ ] Test different stroke widths
- [ ] Test different stroke colors
- [ ] Test stroke opacity
- [ ] Test smoothed vs unsmoothed paths
- [ ] Verify drawings appear correctly

**Code Path:** `editor.addDrawingAnnotation(document, annotation)`

### 14. Add Shape Annotation
**Test Location:** Shape tool in toolbar
- [ ] Add arrow shape
- [ ] Add rectangle shape
- [ ] Add circle shape
- [ ] Test different stroke colors
- [ ] Test different fill colors
- [ ] Test fill opacity
- [ ] Test corner radius (for rectangles)
- [ ] Test arrow head size
- [ ] Verify shapes appear correctly

**Code Path:** `editor.addShapeAnnotation(document, annotation)`

### 15. Add Form Field Annotation
**Test Location:** Form tool in toolbar
- [ ] Add text field
- [ ] Add checkbox field
- [ ] Add radio button field
- [ ] Add dropdown field
- [ ] Add date field
- [ ] Test field properties (required, readOnly, multiline)
- [ ] Test field values
- [ ] Test radio button groups
- [ ] Verify form fields are interactive

**Code Path:** `editor.addFormFieldAnnotation(document, annotation)`

### 16. Add Stamp Annotation
**Test Location:** Stamp tool in toolbar
- [ ] Add text stamp
- [ ] Add image stamp
- [ ] Add signature stamp
- [ ] Test stamp positioning
- [ ] Test stamp scaling
- [ ] Test custom stamps from gallery
- [ ] Verify stamps appear correctly

**Code Path:** `editor.addStampAnnotation(document, annotation)`

### 17. Update Annotation
**Test Location:** Click on existing annotation to edit
- [ ] Update text annotation content
- [ ] Update annotation position
- [ ] Update annotation size
- [ ] Update annotation properties (color, font, etc.)
- [ ] Verify changes persist after save/reload

**Code Path:** `editor.updateAnnotation(document, annotation)`

### 18. Update Form Field Value
**Test Location:** Interact with form fields
- [ ] Update text field value
- [ ] Toggle checkbox value
- [ ] Select radio button option
- [ ] Select dropdown option
- [ ] Update date field value
- [ ] Verify values persist after save/reload

**Code Path:** `editor.updateFormFieldValue(document, annotation)`

### 19. Update Annotation in PDF
**Test Location:** Direct PDF annotation updates
- [ ] Update annotation properties directly in PDF
- [ ] Verify updates are reflected in UI
- [ ] Test with different annotation types

**Code Path:** `editor.updateAnnotationInPdf(document, pdfAnnotation, updates)`

### 20. Delete Annotation
**Test Location:** Delete button on annotation, keyboard delete
- [ ] Delete text annotation
- [ ] Delete highlight annotation
- [ ] Delete image annotation
- [ ] Delete drawing annotation
- [ ] Delete multiple annotations
- [ ] Verify deletion persists after save/reload

**Code Path:** `editor.deleteAnnotation(document, annotation)`

### 21. Detect Form Fields
**Test Location:** Form tool → Auto-detect
- [ ] Detect form fields on a page with existing PDF form fields
- [ ] Verify detected fields are added as annotations
- [ ] Test with different form field types
- [ ] Verify field properties are detected correctly

**Code Path:** `editor.detectFormFields(document, pageNumber)`

---

## 📥 Annotation Loading (PDFAnnotationLoader.ts)

### 22. Load Annotations from Page
**Test Location:** Opening PDFs with existing annotations
- [ ] Open PDF with text annotations
- [ ] Open PDF with highlight annotations
- [ ] Open PDF with image annotations
- [ ] Open PDF with drawing annotations
- [ ] Open PDF with form fields
- [ ] Open PDF with stamps
- [ ] Verify all annotation types load correctly
- [ ] Verify annotation positions are correct
- [ ] Verify annotation properties are preserved
- [ ] Test with PDFs that have many annotations
- [ ] Test with PDFs from different sources

**Code Path:** `editor.loadAnnotationsFromPage(document, pageNumber)`

---

## 💾 Document Operations (PDFDocumentOperations.ts)

### 23. Sync All Annotations
**Test Location:** Automatic during save operations
- [ ] Sync annotations to PDF before saving
- [ ] Verify annotations are embedded in PDF
- [ ] Test with multiple annotation types
- [ ] Test with annotations on multiple pages
- [ ] Verify annotations persist after reopening PDF

**Code Path:** `editor.syncAllAnnotations(document, annotations)`

### 24. Sync All Annotations Extended
**Test Location:** Automatic during save operations
- [ ] Sync annotations with extended properties
- [ ] Verify all annotation metadata is preserved
- [ ] Test with complex annotations (stamps, forms, etc.)
- [ ] Verify annotations work in external PDF viewers

**Code Path:** `editor.syncAllAnnotationsExtended(document, annotations)`

### 25. Save Document
**Test Location:** File menu → Save, Toolbar → Save
- [ ] Save document with annotations
- [ ] Save document without annotations
- [ ] Save document with multiple annotation types
- [ ] Save document with annotations on multiple pages
- [ ] Verify saved PDF opens correctly
- [ ] Verify annotations are preserved in saved PDF
- [ ] Test saving to different locations
- [ ] Test saving large documents

**Code Path:** `editor.saveDocument(document, annotations)`

### 26. Export Page as PDF
**Test Location:** Thumbnail carousel → Export page
- [ ] Export single page as PDF
- [ ] Export page with annotations
- [ ] Export page without annotations
- [ ] Verify exported PDF contains correct page
- [ ] Verify exported PDF contains annotations
- [ ] Test exporting different pages
- [ ] Verify exported PDF is valid

**Code Path:** `editor.exportPageAsPDF(document, pageNumber, annotations)`

### 27. Flatten All Annotations
**Test Location:** Page Tools → Flatten Annotations
- [ ] Flatten all annotations in document
- [ ] Flatten annotations on current page only
- [ ] Verify annotations are baked into page content
- [ ] Verify annotations are no longer editable after flattening
- [ ] Verify flattened PDF opens in external viewers
- [ ] Test with different annotation types
- [ ] Test with multiple pages
- [ ] Verify document size changes appropriately

**Code Path:** `editor.flattenAllAnnotations(document, currentPageOnly, pageNumber)`

---

## 🔄 Integration Tests

### 28. Complex Workflows
- [ ] Create document → Add annotations → Reorder pages → Save → Reopen
- [ ] Open PDF → Add annotations → Delete pages → Save
- [ ] Add annotations → Rotate pages → Flatten → Save
- [ ] Insert pages → Add annotations → Export page → Save
- [ ] Load PDF with annotations → Edit annotations → Save
- [ ] Multiple documents open → Switch between → Edit → Save each

### 29. Error Handling
- [ ] Test with corrupted PDF files
- [ ] Test with very large PDF files
- [ ] Test with PDFs that have many pages
- [ ] Test with PDFs that have many annotations
- [ ] Test invalid operations (e.g., delete all pages)
- [ ] Verify error messages are clear

### 30. Performance
- [ ] Test with large documents (100+ pages)
- [ ] Test with many annotations (100+ per page)
- [ ] Test save/load performance
- [ ] Test annotation rendering performance
- [ ] Test page operations performance

---

## 📋 Quick Smoke Test (Minimum Viable Testing)

If you're short on time, at minimum test these critical paths:

1. **Open PDF** - Load a PDF with existing annotations
2. **Add Text Annotation** - Add a text box and verify it appears
3. **Add Highlight** - Highlight some text
4. **Reorder Pages** - Drag a page to reorder
5. **Delete Page** - Delete a page
6. **Save Document** - Save and verify annotations persist
7. **Reopen Saved PDF** - Open the saved PDF and verify everything is there
8. **Flatten Annotations** - Flatten and verify they're baked in

---

## 🐛 Known Issues to Watch For

- Annotation positions after page operations
- Annotation properties not persisting
- Form field values not saving
- Stamps not appearing correctly
- Redactions not applying
- Performance issues with large documents

---

## 📝 Notes

- All 27 public methods should be tested
- Focus on user-facing functionality
- Test both happy paths and edge cases
- Verify data persistence (save/reload)
- Test with different PDF sources (generated, scanned, etc.)









