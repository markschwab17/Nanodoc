#!/bin/bash

# Create placeholder icons for Tauri
ICONS_DIR="src-tauri/icons"
mkdir -p "$ICONS_DIR"

# Create a minimal valid 1x1 blue PNG (base64 encoded)
# This is a 1x1 blue pixel PNG
BLUE_PIXEL="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

# Create temporary 1x1 PNG
echo "$BLUE_PIXEL" | base64 -d > "$ICONS_DIR/temp.png"

# Resize to required sizes using sips
sips -z 32 32 "$ICONS_DIR/temp.png" --out "$ICONS_DIR/32x32.png" > /dev/null 2>&1
sips -z 128 128 "$ICONS_DIR/temp.png" --out "$ICONS_DIR/128x128.png" > /dev/null 2>&1
sips -z 256 256 "$ICONS_DIR/temp.png" --out "$ICONS_DIR/128x128@2x.png" > /dev/null 2>&1

# Create proper ICNS file for macOS
mkdir -p "$ICONS_DIR/icon.iconset"
cp "$ICONS_DIR/32x32.png" "$ICONS_DIR/icon.iconset/icon_16x16.png"
cp "$ICONS_DIR/32x32.png" "$ICONS_DIR/icon.iconset/icon_16x16@2x.png"
cp "$ICONS_DIR/128x128.png" "$ICONS_DIR/icon.iconset/icon_32x32.png"
cp "$ICONS_DIR/128x128@2x.png" "$ICONS_DIR/icon.iconset/icon_32x32@2x.png"
cp "$ICONS_DIR/128x128.png" "$ICONS_DIR/icon.iconset/icon_128x128.png"
cp "$ICONS_DIR/128x128@2x.png" "$ICONS_DIR/icon.iconset/icon_128x128@2x.png"
cp "$ICONS_DIR/128x128.png" "$ICONS_DIR/icon.iconset/icon_256x256.png"
cp "$ICONS_DIR/128x128@2x.png" "$ICONS_DIR/icon.iconset/icon_256x256@2x.png"
cp "$ICONS_DIR/128x128@2x.png" "$ICONS_DIR/icon.iconset/icon_512x512.png"
cp "$ICONS_DIR/128x128@2x.png" "$ICONS_DIR/icon.iconset/icon_512x512@2x.png"
iconutil -c icns "$ICONS_DIR/icon.iconset" -o "$ICONS_DIR/icon.icns" 2>/dev/null
rm -rf "$ICONS_DIR/icon.iconset"

# Create proper ICO file for Windows
python3 << 'PYTHON_EOF'
from struct import pack

def create_ico(png32_path, png128_path, output_path):
    with open(png32_path, 'rb') as f:
        png32_data = f.read()
    with open(png128_path, 'rb') as f:
        png128_data = f.read()
    
    # ICO header
    ico_data = pack('<HHH', 0, 1, 2)  # reserved, type=1 (ICO), count=2
    
    # Directory entry for 32x32
    offset = 6 + (16 * 2)  # header + 2 directory entries
    ico_data += pack('<BBBBHHII', 
        32, 32,  # width, height
        0,       # color palette (0 = no palette)
        0,       # reserved
        1,       # color planes
        32,      # bits per pixel
        len(png32_data),  # image size
        offset)   # offset to image data
    
    # Directory entry for 128x128
    offset += len(png32_data)
    ico_data += pack('<BBBBHHII',
        128, 128,  # width, height
        0,         # color palette
        0,         # reserved
        1,         # color planes
        32,        # bits per pixel
        len(png128_data),  # image size
        offset)     # offset to image data
    
    # Append image data
    ico_data += png32_data
    ico_data += png128_data
    
    with open(output_path, 'wb') as f:
        f.write(ico_data)

create_ico('src-tauri/icons/32x32.png', 'src-tauri/icons/128x128.png', 'src-tauri/icons/icon.ico')
PYTHON_EOF

# Clean up
rm -f "$ICONS_DIR/temp.png"

echo "✓ Placeholder icons created in $ICONS_DIR"
echo "  - 32x32.png"
echo "  - 128x128.png"
echo "  - 128x128@2x.png"
echo "  - icon.icns (macOS)"
echo "  - icon.ico (Windows)"
echo ""
echo "Note: Replace with proper branded icons for production builds."
