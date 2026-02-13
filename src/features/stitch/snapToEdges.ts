/**
 * Snap a tile's position so its edges align to other tiles' edges and canvas edges.
 */

import type { StitchTile } from "@/shared/stores/stitchStore";

const SNAP_THRESHOLD = 12;

export function snapTilePosition(
  movingTileId: string,
  x: number,
  y: number,
  width: number,
  height: number,
  allTiles: StitchTile[],
  canvasWidth: number,
  canvasHeight: number,
  threshold: number = SNAP_THRESHOLD
): { x: number; y: number } {
  const others = allTiles.filter((t) => t.id !== movingTileId);

  const xTargets: number[] = [0, canvasWidth];
  others.forEach((t) => {
    xTargets.push(t.x, t.x + t.width);
  });
  const yTargets: number[] = [0, canvasHeight];
  others.forEach((t) => {
    yTargets.push(t.y, t.y + t.height);
  });

  // X: snap left edge (x) or right edge (x+width) to nearest target
  let snapXLeft = x;
  let distLeft = threshold + 1;
  let snapXRight = x;
  let distRight = threshold + 1;
  for (const target of xTargets) {
    const dL = Math.abs(x - target);
    if (dL < distLeft) {
      distLeft = dL;
      snapXLeft = target;
    }
    const dR = Math.abs(x + width - target);
    if (dR < distRight) {
      distRight = dR;
      snapXRight = target - width;
    }
  }
  const snappedX = distLeft <= distRight && distLeft <= threshold
    ? snapXLeft
    : distRight <= threshold
      ? snapXRight
      : x;

  // Y: snap top edge (y) or bottom edge (y+height) to nearest target
  let snapYTop = y;
  let distTop = threshold + 1;
  let snapYBottom = y;
  let distBottom = threshold + 1;
  for (const target of yTargets) {
    const dT = Math.abs(y - target);
    if (dT < distTop) {
      distTop = dT;
      snapYTop = target;
    }
    const dB = Math.abs(y + height - target);
    if (dB < distBottom) {
      distBottom = dB;
      snapYBottom = target - height;
    }
  }
  const snappedY = distTop <= distBottom && distTop <= threshold
    ? snapYTop
    : distBottom <= threshold
      ? snapYBottom
      : y;

  return { x: snappedX, y: snappedY };
}
