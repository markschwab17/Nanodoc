# Stitch layout training (Colab)

Train the implicit layout model using your exported stitch training bundles.

## Open in Google Colab

1. Go to [Google Colab](https://colab.research.google.com/).
2. **File → Upload notebook** and choose `stitch_layout_training.ipynb` from this folder.
3. **Runtime → Change runtime type** and set **Hardware accelerator** to **T4 GPU** (or any GPU).
4. Run the cells in order (Step 1 through Step 6).

## Prepare your data

- Export training bundles from the Stitch tool: use **“For training”** to download ZIPs (each has `controls.json`, `tiles/*.png`, `stitched.pdf`, `stitched.png`).
- For Colab, either:
  - **Upload one zip:** Put all your `stitch-training-*.zip` files into one folder, zip that folder, and upload that zip in Step 2; the notebook will extract everything and find all bundles.
  - Or upload a single `stitch-training-*.zip` to try with one bundle first.

## After training

- The last cell saves the model to `stitch_layout_model.pt` and triggers a download. Use this file when you implement “auto-stitch” in the app (load the state dict and run the same model architecture).
