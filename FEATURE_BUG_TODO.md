# Feature & Bug TODO

## Bugs & Fixes

### High Priority

- [ ] **Fix rotating rectangles correct direction**
  - Rectangles are rotating in the wrong direction
  - Need to correct rotation logic

- [ ] **Fix text box sizing and font scaling**
  - Allow for smaller text boxes to be created
  - Text font should automatically resize to fit the size of the text box when clicked and drawn
  - Implement dynamic font scaling based on box dimensions

- [ ] **All tools need to work in read mode**
  - Currently not all tools function properly in read mode
  - Need to audit and fix each tool to ensure read mode compatibility

### Medium Priority

- [ ] **Check and verify resize PDF document functionality**
  - Audit all resize PDF document features
  - Ensure resize operations work correctly
  - Test edge cases and document integrity after resize

- [ ] **Check and verify print options**
  - Audit all print functionality
  - Ensure print options work correctly
  - Test various print settings and configurations

- [ ] **Support rotating pages while maintaining size**
  - Allow page rotation without changing page dimensions
  - Maintain original page size when rotating
  - Ensure content scales appropriately during rotation

- [ ] **Fillable forms - large rework**
  - Fillable fields that were created outside of the program need to work
  - Ensure compatibility with external PDF form fields
  - Test and fix field recognition and interaction

- [ ] **Typewriter mode**
  - Create a quick text creation mode
  - Text should be created without a bounding box
  - Click and type directly on the PDF

### Lower Priority

- [ ] **Conditional drop downs in fillable forms**
  - Allow form fields to have conditional logic
  - Dropdown values should change based on other field selections

- [ ] **Proper signature field**
  - Implement a dedicated signature field type
  - Support signature capture and validation

## Future Enhancements

### Content Management

- [ ] **PDF content selection and multi-page combination**
  - Allow for content selection from PDF pages
  - Resize selected PDF content
  - Add multiple PDFs to a single page
  - Combine PDFs (e.g., stitch construction plan sets together)
  - Enable layout and positioning of multiple PDF sources on one page

### Signature Workflow

- [ ] **PDF signature links with authentication**
  - Create temporary expiring storage for PDFs sent for signature
  - Send signature request links
  - Email authentication with code verification
  - Allow recipients to sign after authentication
  - Implement secure, time-limited access

---

## Notes

- This file tracks all known bugs and planned features
- Items are prioritized based on impact and user needs
- Check off items as they are completed
