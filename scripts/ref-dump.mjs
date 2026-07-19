import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as crypto from "node:crypto";
const REPO = process.cwd();
// reuse the harness OCR cache + encoder by importing nothing; inline minimal
const CACHE_FILE = path.join(REPO, "scratch-diag", "ocr-cache.json");
const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) : {};
function hashImage(image){const h=crypto.createHash("sha1");h.update(Buffer.from([image.width&255,(image.width>>8)&255,image.height&255,(image.height>>8)&255]));h.update(Buffer.from(image.data.buffer,image.data.byteOffset,image.data.byteLength));return h.digest("hex");}
const CRC=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
function crc32(b){let c=0xffffffff;for(let i=0;i<b.length;i++)c=CRC[(c^b[i])&0xff]^(c>>>8);return(c^0xffffffff)>>>0;}
function chunk(t,d){const l=Buffer.alloc(4);l.writeUInt32BE(d.length,0);const ty=Buffer.from(t,"ascii");const cr=Buffer.alloc(4);cr.writeUInt32BE(crc32(Buffer.concat([ty,d])),0);return Buffer.concat([l,ty,d,cr]);}
function encodePNG(w,h,rgba){const sig=Buffer.from([137,80,78,71,13,10,26,10]);const ih=Buffer.alloc(13);ih.writeUInt32BE(w,0);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=6;const st=w*4;const raw=Buffer.alloc((st+1)*h);for(let y=0;y<h;y++){raw[y*(st+1)]=0;Buffer.from(rgba.buffer,rgba.byteOffset+y*st,st).copy(raw,y*(st+1)+1);}return Buffer.concat([sig,chunk("IHDR",ih),chunk("IDAT",zlib.deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]);}
let worker=null;
async function ocr(image){const key=hashImage(image);if(cache[key])return cache[key];if(!worker){const{createWorker,PSM}=await import("tesseract.js");worker=await createWorker("eng",1,{langPath:path.join(REPO,"public/ocr"),gzip:true,cachePath:path.join(REPO,"scratch-diag/tesscache")});await worker.setParameters({tessedit_pageseg_mode:PSM.SPARSE_TEXT});}const png=encodePNG(image.width,image.height,image.data);const{data}=await worker.recognize(png);const words=[];for(const w of data.words??[]){if(!w.text?.trim())continue;words.push({text:w.text.trim(),confidence:w.confidence,bbox:{...w.bbox}});}return words;}

const mupdfMod = await import("mupdf");
const mupdf = mupdfMod.default ?? mupdfMod;
const { capturePage } = await import("../src/features/stitch/autostitch/captureDevice.ts");
const { parseSheetRefs } = await import("../src/features/stitch/autostitch/tokens.ts");
const { pageEdgeBands, rotateRaw, wordsToLabels } = await import("../src/features/stitch/autostitch/ocrBands.ts");
const { renderBand } = await import("../src/features/stitch/autostitch/bandRender.ts");
const bytes = fs.readFileSync("/Users/markschwab/Downloads/PG_SITE 1A.pdf");
const doc = mupdf.Document.openDocument(new Uint8Array(bytes), "application/pdf");
for (let pi = 0; pi <= 9; pi++) {
  const page = doc.loadPage(pi);
  const ex = capturePage(mupdf, page);
  const recovered = [];
  for (const band of pageEdgeBands(ex.view)) {
    const { image, scale: bandScale } = renderBand(mupdf, page, band.clip);
    if (band.edge === "left" || band.edge === "right") {
      const cands = [];
      for (const rot of [90,270]) cands.push({rot, words: await ocr(rotateRaw(image, rot))});
      const score = ws => ws.reduce((s,w)=>s+Math.max(0,w.confidence-50),0);
      const best = cands.sort((a,b)=>score(b.words)-score(a.words))[0];
      recovered.push(...wordsToLabels(best.words, band, bandScale, image.width, image.height, best.rot));
    } else {
      recovered.push(...wordsToLabels(await ocr(image), band, bandScale, image.width, image.height, 0));
    }
  }
  const refs = parseSheetRefs(recovered, ex.view).filter(r => r.sheet!=null || r.matchline || r.strip);
  console.log(`\n=== pageIndex ${pi} (p${pi+1}) ===`);
  for (const r of refs) console.log(`  [${r.edge}] sheet=${r.sheet} match=${r.matchline} strip=${r.strip}/${r.stripSide} at=(${Math.round(r.at.x)},${Math.round(r.at.y)}) "${r.text.slice(0,45)}"`);
  page.destroy?.();
}
if (worker) await worker.terminate();
