/**
 * Color utility functions for PDF operations
 */

/**
 * Parse a hex color string to RGB array [r, g, b] where values are 0-1
 * @param color Hex color string (e.g., "#FF0000" or "FF0000")
 * @returns RGB array with values between 0 and 1
 */
export function parseColor(color: string): number[] {
  // Convert hex color to RGB array [r, g, b] where values are 0-1
  const hex = color.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;
  return [r, g, b];
}













