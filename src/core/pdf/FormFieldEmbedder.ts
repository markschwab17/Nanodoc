/**
 * FormFieldEmbedder — writes REAL AcroForm fields into saved PDF bytes.
 *
 * Why pdf-lib and not mupdf: mupdf 1.26.4 WASM cannot create functional
 * Widget annotations — createAnnotation("Widget") fails to generate an
 * appearance stream and the widget is never registered under /AcroForm, so
 * Adobe/Word/Preview show nothing. pdf-lib's forms API builds the full field
 * structure (/AcroForm, /FT, /T, /V, /DA, generated appearance streams) that
 * other viewers can render AND fill.
 *
 * Runs as a save post-pass on the mupdf-saved bytes — the same pattern as
 * ImageStampEmbedder. The mupdf-side save deletes any previously-written
 * widgets first (delete-then-recreate, like other annotation types), so this
 * pass always starts clean.
 */

import type { Annotation } from "./types";

export class FormFieldEmbedder {
  /** True for annotations this embedder owns. */
  static isFormField(annot: Annotation): boolean {
    return annot.type === "formField" && !!annot.fieldType;
  }

  async embedFields(pdfBuffer: Uint8Array, fields: Annotation[]): Promise<Uint8Array> {
    if (fields.length === 0) return pdfBuffer;

    const { PDFDocument, PDFName, PDFString, PDFArray, StandardFonts } = await import("pdf-lib");
    const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const form = pdfDoc.getForm();
    const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);

    // A pre-existing AcroForm dict (e.g. left behind by the mupdf save after
    // the delete-then-recreate pass) may have no form-level /DA — pdf-lib
    // then throws MissingDAEntryError when generating field appearances.
    // Provide the same default a fresh pdf-lib AcroForm would have.
    if (!form.acroForm.dict.lookup(PDFName.of("DA"))) {
      form.acroForm.dict.set(PDFName.of("DA"), PDFString.of("/Helv 0 Tf 0 g"));
    }

    const usedNames = new Set<string>(
      form.getFields().map((f) => f.getName()),
    );
    const uniqueName = (base: string): string => {
      let name = base && base.trim() ? base.trim() : "Field";
      let i = 2;
      while (usedNames.has(name)) name = `${base}_${i++}`;
      usedNames.add(name);
      return name;
    };

    // Radio widgets that share a radioGroup become OPTIONS of one group field.
    const radioGroups = new Map<string, Annotation[]>();

    for (const annot of fields) {
      if (annot.fieldType === "radio") {
        const group = annot.radioGroup || "RadioGroup";
        if (!radioGroups.has(group)) radioGroups.set(group, []);
        radioGroups.get(group)!.push(annot);
      }
    }

    for (const annot of fields) {
      if (annot.fieldType === "radio") continue; // handled per-group below
      try {
        const page = pdfDoc.getPage(annot.pageNumber);
        const rect = {
          x: annot.x,
          y: annot.y,
          width: annot.width || 100,
          height: annot.height || 24,
        };
        const name = uniqueName(annot.fieldName || annot.fieldType || "Field");

        switch (annot.fieldType) {
          case "text":
          case "date":
          case "email":
          case "number": {
            const tf = form.createTextField(name);
            // Field-level /DA must be set explicitly: pdf-lib's create()
            // leaves it empty and setFontSize() THROWS without it (which
            // aborted addToPage and left fields with no visible widget).
            tf.acroField.setDefaultAppearance(`/Helv ${annot.fontSize ?? 12} Tf 0 g`);
            if (annot.fieldValue != null && annot.fieldValue !== false) {
              tf.setText(String(annot.fieldValue));
            }
            if (annot.multiline) tf.enableMultiline();
            tf.addToPage(page, rect);
            // Round-trippable validation semantics (email/number/date) — a
            // custom key other viewers ignore but our loader can restore.
            if (annot.fieldType !== "text") {
              tf.acroField.dict.set(
                PDFName.of("NanodocValidation"),
                PDFName.of(annot.fieldType),
              );
            }
            break;
          }
          case "checkbox": {
            const cb = form.createCheckBox(name);
            cb.addToPage(page, rect);
            if (annot.fieldValue === true || annot.fieldValue === "true") cb.check();
            else cb.uncheck();
            break;
          }
          case "dropdown": {
            const dd = form.createDropdown(name);
            dd.acroField.setDefaultAppearance(`/Helv ${annot.fontSize ?? 12} Tf 0 g`);
            dd.addOptions(annot.options ?? []);
            dd.addToPage(page, rect);
            const v = annot.fieldValue != null ? String(annot.fieldValue) : "";
            if (v && (annot.options ?? []).includes(v)) dd.select(v);
            break;
          }
          case "listbox": {
            const lb = form.createOptionList(name);
            lb.acroField.setDefaultAppearance(`/Helv ${annot.fontSize ?? 12} Tf 0 g`);
            lb.addOptions(annot.options ?? []);
            lb.addToPage(page, rect);
            const v = annot.fieldValue != null ? String(annot.fieldValue) : "";
            if (v && (annot.options ?? []).includes(v)) lb.select(v);
            break;
          }
          case "signature": {
            // pdf-lib has no /Sig API — build the empty signature field
            // low-level so Acrobat shows a signable field.
            const context = pdfDoc.context;
            const widgetDict = context.obj({
              Type: "Annot",
              Subtype: "Widget",
              FT: "Sig",
              Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
              T: PDFString.of(name),
              F: 4,
              P: page.ref,
            });
            const widgetRef = context.register(widgetDict);
            const annots = page.node.lookup(PDFName.of("Annots"), PDFArray);
            if (annots) annots.push(widgetRef);
            else page.node.set(PDFName.of("Annots"), context.obj([widgetRef]));
            form.acroForm.addField(widgetRef);
            break;
          }
          default:
            console.warn(`[FormFieldEmbedder] Unknown fieldType "${annot.fieldType}" — skipped`);
        }
      } catch (e) {
        console.error(`[FormFieldEmbedder] Failed to embed field ${annot.fieldName}:`, e);
      }
    }

    // Radio groups: one field per group, one widget option per annotation.
    for (const [group, members] of radioGroups) {
      try {
        const name = uniqueName(group);
        const rg = form.createRadioGroup(name);
        let selected: string | null = null;
        for (const annot of members) {
          const page = pdfDoc.getPage(annot.pageNumber);
          const optionName = annot.fieldName || `Option_${members.indexOf(annot) + 1}`;
          rg.addOptionToPage(optionName, page, {
            x: annot.x,
            y: annot.y,
            width: annot.width || 18,
            height: annot.height || 18,
          });
          if (annot.fieldValue === true || annot.fieldValue === "true") selected = optionName;
        }
        if (selected) rg.select(selected);
      } catch (e) {
        console.error(`[FormFieldEmbedder] Failed to embed radio group ${group}:`, e);
      }
    }

    // Generate appearance streams for every new field in one pass so the
    // fields render in viewers that don't honor NeedAppearances.
    try {
      form.updateFieldAppearances(helvetica);
    } catch (e) {
      console.warn("[FormFieldEmbedder] Appearance generation failed (fields remain fillable):", e);
    }

    return pdfDoc.save({ useObjectStreams: false });
  }
}
