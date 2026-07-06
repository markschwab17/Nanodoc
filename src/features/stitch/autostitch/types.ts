export interface Label { text: string; x: number; y: number; endX: number; endY: number; angle: number; h: number; font: string | null; atoms?: number; }
export interface Geom { id: string; pts: [number, number][]; closed: boolean; }
export interface Atom { text: string; x: number; y: number; dirX: number; dirY: number; h: number; len: number; angle: number; font: string | null; }
export interface PageExtract { view: [number, number, number, number]; shxLabels: Label[]; labels: Label[]; words: Label[]; geometry: Geom[]; }
export interface Pt { x: number; y: number; }
