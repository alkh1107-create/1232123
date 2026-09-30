export const PRESETS = {
  natural: { label: 'Чистый', description: 'Нейтральный цвет и естественный свет' },
  soft: { label: 'Soft editorial', description: 'Мягкий контраст, спокойный цвет, тёплые света', contrast:-8, shadows:10, highlights:-16, warmth:4, color:-6, fade:3, split:2 },
  film: { label: 'Golden film', description: 'Тёплая плёнка, приподнятые тени, мягкое зерно', contrast:8, shadows:5, highlights:-22, warmth:13, color:-9, fade:7, split:7, grain:8 },
  city: { label: 'City mood', description: 'Глубокие тени и прохладный городской цвет', contrast:17, shadows:-10, highlights:-16, warmth:-7, color:-14, split:9, vignette:12 },
  travel: { label: 'Travel color', description: 'Чистые пейзажи и выразительные, умеренные цвета', contrast:8, shadows:9, highlights:-20, warmth:3, color:18, sharpen:12 },
  mono: { label: 'Silver', description: 'Монохромная плёнка с мягким зерном', contrast:18, highlights:-12, fade:2, grain:10, mono:1 }
};
export const EDIT_KEYS = ['exposure','contrast','highlights','shadows','warmth','tint','color','fade','sharpen','grain','vignette'];
export const defaults = () => Object.fromEntries([...EDIT_KEYS.map(k => [k,0]), ['preset','natural'], ['strength',75]]);
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi,x));
const linear = Float32Array.from({ length: 256 }, (_,i) => {
  const x = i / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4;
});
const encoded = Float32Array.from({ length: 8193 }, (_,i) => {
  const x = i / 8192; return x <= .0031308 ? x * 12.92 : 1.055 * x ** (1/2.4) - .055;
});
const encode = x => encoded[Math.round(clamp(x) * 8192)];

export function processPixels(data, width, height, edit) {
  const preset = PRESETS[edit.preset] || PRESETS.natural;
  const amount = clamp(Number(edit.strength ?? 75) / 100);
  const p = {};
  for (const key of EDIT_KEYS) p[key] = Number(edit[key] || 0) + Number(preset[key] || 0) * amount;
  const split = (preset.split || 0) * amount / 100;
  const mono = (preset.mono || 0) * amount;
  const exposure = 2 ** p.exposure;
  const wr = 2 ** (p.warmth / 160 + p.tint / 280);
  const wg = 2 ** (-p.tint / 180);
  const wb = 2 ** (-p.warmth / 160 + p.tint / 280);
  const contrast = 1 + p.contrast / 100;
  const fade = clamp(p.fade / 100,0,.4);
  const hasChanges = EDIT_KEYS.some(k => p[k]) || split || mono;
  if (!hasChanges) return data;
  for (let i = 0, pixel = 0; i < data.length; i += 4, pixel++) {
    let r = encode(linear[data[i]] * exposure * wr);
    let g = encode(linear[data[i+1]] * exposure * wg);
    let b = encode(linear[data[i+2]] * exposure * wb);
    let y = .2126*r + .7152*g + .0722*b;
    // Luminance masks avoid raising all blacks or dimming the whole photograph.
    const shadowMask = (1 - y) ** 3;
    const highlightMask = y ** 3;
    const tone = p.shadows / 100 * shadowMask * .4 + p.highlights / 100 * highlightMask * .4;
    const target = clamp((y + tone - .45) * contrast + .45);
    const delta = target - y;
    r += delta; g += delta; b += delta; y = target;
    const saturation = Math.max(r,g,b) - Math.min(r,g,b);
    // A modest protection for warm skin-like colors; not a semantic skin mask.
    const warmColor = r > g && g > b && r-b < .5 ? .65 : 1;
    const vibrance = 1 + p.color / 100 * (p.color > 0 ? (1 - clamp(saturation)) * warmColor : 1);
    r = y + (r-y)*vibrance; g = y + (g-y)*vibrance; b = y + (b-y)*vibrance;
    const gray = .28*r + .60*g + .12*b;
    r = r*(1-mono)+gray*mono; g = g*(1-mono)+gray*mono; b = b*(1-mono)+gray*mono;
    r += split * (highlightMask*.65-shadowMask*.35);
    g += split * shadowMask * .13;
    b += split * (shadowMask*.65-highlightMask*.4);
    r = fade + r*(1-fade*1.45); g = fade + g*(1-fade*1.45); b = fade + b*(1-fade*1.45);
    const px = pixel % width, py = Math.floor(pixel / width);
    const dist = ((px / Math.max(1,width-1) - .5) ** 2 + (py / Math.max(1,height-1) - .5) ** 2) * 2;
    const shade = 1 - p.vignette / 100 * dist ** 1.3 * .55;
    // Fixed noise: slider changes do not flicker.
    const hash = Math.imul(pixel ^ 0x45d9f3b, 0x45d9f3b) >>> 0;
    const noise = ((hash & 1023) / 1023 - .5) * p.grain / 100 * .09;
    data[i] = clamp(r*shade+noise)*255;
    data[i+1] = clamp(g*shade+noise)*255;
    data[i+2] = clamp(b*shade+noise)*255;
  }
  if (p.sharpen > 0) {
    const luma = new Uint8Array(width*height);
    for (let i=0,j=0;i<data.length;i+=4,j++) luma[j]=.2126*data[i]+.7152*data[i+1]+.0722*data[i+2];
    const strength = clamp(p.sharpen/100)*.7;
    for (let y=1;y<height-1;y++) for (let x=1;x<width-1;x++) {
      const at=y*width+x;
      const detail=clamp((luma[at]-(luma[at-1]+luma[at+1]+luma[at-width]+luma[at+width])/4)*strength,-12,12);
      if (Math.abs(detail)<1) continue;
      for(let c=0;c<3;c++) data[at*4+c]=clamp(data[at*4+c]+detail,0,255);
    }
  }
  return data;
}

export function autoSettings(data) {
  const hist = new Uint32Array(256);
  let clipped = 0;
  for (let i=0;i<data.length;i+=4) {
    const y=Math.round(.2126*data[i]+.7152*data[i+1]+.0722*data[i+2]);
    hist[y]++; if(y>247) clipped++;
  }
  const count=data.length/4;
  const quantile = q => { let n=0; for(let i=0;i<256;i++){ n+=hist[i]; if(n>=count*q) return i; } return 255; };
  const p10=quantile(.1), median=quantile(.5), p90=quantile(.9);
  // Restrained correction: keep night scenes dark and high-key scenes bright.
  const exposure=clamp(Math.log2(110/Math.max(25,median))*.45,-.6,.65);
  return { exposure: Math.round(exposure*100)/100,
    shadows: p10<38 ? Math.round((38-p10)*.65) : 0,
    highlights: p90>210 ? -Math.round((p90-210)*.65 + Math.min(12,clipped/count*100)) : -5,
    contrast: p90-p10<120 ? 9 : 2, color:6, sharpen:12 };
}

export function cropRect(width, height, ratio, position = .5) {
  if (!ratio) return { x:0,y:0,w:width,h:height };
  const w = Math.min(width,height*ratio), h=w/ratio;
  return { x:Math.round((width-w)*position), y:Math.round((height-h)*position),
    w:Math.round(w), h:Math.round(h) };
}
