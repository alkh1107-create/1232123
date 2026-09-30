import { PRESETS, EDIT_KEYS, defaults, autoSettings, cropRect } from './darkroom.js';
const $ = id => document.getElementById(id);
const tick = () => new Promise(resolve => requestAnimationFrame(resolve));

class PixelWorker {
  constructor() {
    this.jobs = new Map(); this.id = 0;
    this.worker = new Worker(new URL('./darkroom-worker.js', import.meta.url), { type:'module' });
    this.worker.onmessage = ({ data }) => {
      const job = this.jobs.get(data.id);
      if (!job) return;
      clearTimeout(job.timer); this.jobs.delete(data.id);
      data.error ? job.reject(new Error(data.error)) : job.resolve(new Uint8ClampedArray(data.buffer));
    };
    this.worker.onerror = () => this.fail(new Error('Не удалось запустить обработку'));
  }
  fail(error) {
    this.error = error; this.worker.terminate();
    for (const job of this.jobs.values()) { clearTimeout(job.timer); job.reject(error); }
    this.jobs.clear();
  }
  process(imageData, edit) {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve,reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => this.fail(new Error('Обработка заняла слишком много времени')), 90000);
      this.jobs.set(id,{resolve,reject,timer});
      this.worker.postMessage({id,buffer:imageData.data.buffer,width:imageData.width,height:imageData.height,edit},[imageData.data.buffer]);
    });
  }
}

export class PhotoEditor {
  constructor({ model, toast, onSave, onOriginalScore }) {
    this.model=model; this.toast=toast; this.onSave=onSave;this.onOriginalScore=onOriginalScore;
    this.canvas=$('editor-canvas'); this.ctx=this.canvas.getContext('2d');
    this.processor=new PixelWorker(); this.revision=0; this.edit=defaults();
    this.ratio=0; this.position=.5; this.busy=false; this.holding=false;
    const presets=$('presets'); presets.replaceChildren();
    for (const [key,value] of Object.entries(PRESETS)) {
      const button=document.createElement('button');
      button.className='preset'; button.dataset.preset=key;
      button.innerHTML='<i></i><b></b>';
      button.querySelector('b').textContent=value.label;
      button.title=value.description;
      button.onclick=()=>{this.edit.preset=key; this.changed();};
      presets.append(button);
    }
    for(const key of [...EDIT_KEYS,'strength']) {
      $('edit-'+key).addEventListener('input',event=>{
        this.edit[key]=Number(event.target.value); this.changed();
      });
    }
    $('crop-ratio').onchange=event=>{
      this.ratio=Number(event.target.value); this.position=.5; this.base=null; this.changed();
    };
    $('crop-position').oninput=event=>{
      this.position=Number(event.target.value)/100; this.base=null; this.changed();
    };
    $('auto-enhance').onclick=()=>this.auto();
    $('ai-style').onclick=()=>this.chooseStyle();
    $('ai-crop').onclick=()=>this.chooseCrop();
    $('score-photo').onclick=()=>this.score();
    $('reset-edit').onclick=()=>this.reset();
    $('save-edit').onclick=()=>this.save();
    const compare=$('compare-original');
    compare.addEventListener('pointerdown',event=>{
      if (!this.base || this.busy) return;
      event.preventDefault(); compare.setPointerCapture(event.pointerId);
      this.compare(true);
    });
    for(const type of ['pointerup','pointercancel','lostpointercapture']) compare.addEventListener(type,()=>this.compare(false));
    compare.addEventListener('keydown',event=>{
      if(event.key===' ' || event.key==='Enter'){event.preventDefault();this.compare(true);}
    });
    compare.addEventListener('keyup',()=>this.compare(false));
    compare.addEventListener('blur',()=>this.compare(false));
    this.sync();this.setBusy(false);
  }
  cancel() { this.revision++; this.compare(false); }
  setBusy(value,message='') {
    this.busy=value;
    for(const element of document.querySelectorAll('#page-editor button:not(#close-editor), #page-editor input, #page-editor select')) element.disabled=value || !this.image;
    $('edit-progress').textContent=message;
    $('page-editor').setAttribute('aria-busy',String(value));
  }
  async open(photo) {
    const rev=++this.revision; this.image=null; this.base=null; this.rendered=null;
    this.setBusy(true,'Открываю оригинал…');
    this.ctx.clearRect(0,0,this.canvas.width,this.canvas.height);
    $('editor-empty').hidden=false; $('editor-empty').textContent='Открываю снимок…';
    const url=URL.createObjectURL(photo.blob);
    try {
      const image=new Image(); image.src=url; await image.decode();
      if(rev!==this.revision) return;
      this.image=image; this.photo=photo; this.edit=defaults();this.finalScore=null;
      this.ratio=0; this.position=.5; this.originalScore=photo.aesthetic || null;
      $('crop-ratio').value='0'; $('editor-empty').hidden=true;
      this.sync(); await this.render();
      if(rev===this.revision) { this.setBusy(false); this.score(); }
    } catch(error) {
      if(rev===this.revision) {
        $('editor-empty').hidden=false;
        $('editor-empty').textContent='Не удалось открыть фото. Попробуй JPEG, PNG или WebP.';
        this.toast('Этот формат снимка браузер не прочитал'); this.setBusy(false);
      }
    } finally { URL.revokeObjectURL(url); }
  }
  rect() { return cropRect(this.image.naturalWidth,this.image.naturalHeight,this.ratio,this.position); }
  sourceCanvas(maxSide=1000,maxPixels=1000000,rect=this.rect()) {
    const scale=Math.min(1,maxSide/Math.max(rect.w,rect.h),Math.sqrt(maxPixels/(rect.w*rect.h)));
    const canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(rect.w*scale)); canvas.height=Math.max(1,Math.round(rect.h*scale));
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(this.image,rect.x,rect.y,rect.w,rect.h,0,0,canvas.width,canvas.height);
    return canvas;
  }
  sync() {
    for(const key of [...EDIT_KEYS,'strength']) {
      $('edit-'+key).value=this.edit[key];
      $('edit-'+key+'-value').textContent=key==='exposure' ? this.edit[key].toFixed(2)+' EV' : this.edit[key];
    }
    document.querySelectorAll('.preset').forEach(button=>{
      const selected=button.dataset.preset===this.edit.preset;
      button.classList.toggle('selected',selected); button.setAttribute('aria-pressed',String(selected));
    });
    $('preset-description').textContent=PRESETS[this.edit.preset].description;
    $('crop-position').value=this.position*100;
    $('crop-position').disabled=!this.ratio || this.busy;
    $('crop-position-row').hidden=!this.ratio;
    if(this.image) {
      const rect=this.rect();
      const scale=Math.min(1,4096/Math.max(rect.w,rect.h),Math.sqrt(16000000/(rect.w*rect.h)));
      $('export-size').textContent='JPEG · '+Math.round(rect.w*scale)+' × '+Math.round(rect.h*scale)+(scale<1?' · уменьшено для браузера':' · полное разрешение обрезки');
    }
  }
  changed() {
    this.revision++; this.finalScore=null; this.compare(false);
    $('editor-score').textContent='Изменён кадр · нажми «Оценить»';
    this.sync(); this.render();
  }
  reset() {
    this.edit=defaults(); this.ratio=0; this.position=.5; this.base=null;
    $('crop-ratio').value='0';this.changed();
  }
  async render() {
    this.dirty=true;
    if(this.rendering) return this.rendering;
    this.rendering=(async()=>{
      try {
        while(this.dirty && this.image) {
          this.dirty=false; const rev=this.revision;
          if(!this.base) {
            const raw=this.sourceCanvas();
            this.base=raw.getContext('2d').getImageData(0,0,raw.width,raw.height);
          }
          const {width,height}=this.base;
          const copy=new ImageData(new Uint8ClampedArray(this.base.data),width,height);
          const pixels=await this.processor.process(copy,{...this.edit});
          if(rev!==this.revision) continue;
          this.rendered=new ImageData(pixels,width,height);
          this.canvas.width=width;this.canvas.height=height;
          this.ctx.putImageData(this.holding?this.base:this.rendered,0,0);
        }
      } catch(error) { this.toast(error.message); }
      finally { this.rendering=null; }
    })();
    return this.rendering;
  }
  compare(holding) {
    this.holding=holding;
    $('compare-original').setAttribute('aria-pressed',String(holding));
    $('compare-original').textContent=holding?'ОРИГИНАЛ':'УДЕРЖИ: ДО';
    const data=holding?this.base:this.rendered;
    if(data) this.ctx.putImageData(data,0,0);
  }
  async score() {
    if(!this.image || this.busy || this.scoring) return;
    const rev=this.revision;
    this.scoring=true;
    $('score-photo').disabled=true;
    $('editor-score').textContent='NIMA оценивает фотографию…';
    try {
      await this.render();
      if(rev!==this.revision)return;
      const score=await this.model.score(this.canvas);
      if(rev!==this.revision) return;
      this.finalScore=score;
      $('editor-score').textContent='Эстетика NIMA · '+score.mean.toFixed(2)+' / 10';
      if(!this.ratio && this.edit.preset==='natural' && EDIT_KEYS.every(key=>this.edit[key]===0))
        this.onOriginalScore?.(this.photo,score).catch(()=>{});
    } catch(_) {
      if(rev===this.revision) $('editor-score').textContent='Оценка ИИ недоступна · обработка работает';
    } finally { this.scoring=false;$('score-photo').disabled=this.busy || !this.image; }
  }
  auto() {
    if(!this.image || this.busy) return;
    const canvas=this.sourceCanvas(224,50176);
    Object.assign(this.edit,autoSettings(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data));
    this.changed();this.toast('Свет, тени и цвет скорректированы по снимку');
  }
  async chooseStyle() {
    if(!this.image || this.busy) return;
    const rev=++this.revision;
    this.setBusy(true,'Сравниваю оригинал и 6 обработок…');
    try {
      const canvas=this.sourceCanvas(448,200704);
      const ctx=canvas.getContext('2d',{willReadFrequently:true});
      const raw=ctx.getImageData(0,0,canvas.width,canvas.height);
      const adjusted={...defaults(),...autoSettings(raw.data),strength:this.edit.strength};
      let winner={ edit:defaults(), score:await this.model.score(canvas) };
      const baseline=winner.score.mean;
      let i=0;
      for(const key of Object.keys(PRESETS)) {
        if(rev!==this.revision) return;
        $('edit-progress').textContent='Подбираю стиль · '+(++i)+' / 6';
        const edit={...adjusted,preset:key};
        const pixels=await this.processor.process(new ImageData(new Uint8ClampedArray(raw.data),raw.width,raw.height),edit);
        ctx.putImageData(new ImageData(pixels,raw.width,raw.height),0,0);
        const score=await this.model.score(canvas);
        // Small score differences are not a reliable aesthetic improvement.
        if(score.mean>winner.score.mean+.06) winner={edit,score};
      }
      if(rev!==this.revision) return;
      this.edit=winner.edit; this.finalScore=winner.score;this.sync();await this.render();
      $('editor-score').textContent='NIMA · '+baseline.toFixed(2)+' → '+winner.score.mean.toFixed(2)+' / 10';
      this.toast(winner.score.mean>baseline+.06?'Выбран стиль: '+PRESETS[this.edit.preset].label:'Оригинал оказался не хуже обработок');
    } catch(_) { if(rev===this.revision)this.toast('ИИ недоступен. Выбери стиль вручную или нажми «Авто».'); }
    finally { if(rev===this.revision){this.setBusy(false);this.sync();} }
  }
  async chooseCrop() {
    if(!this.image || this.busy) return;
    if(!this.ratio) {this.toast('Сначала выбери формат: 4:5, 2:3, квадрат или 9:16');return;}
    const rev=++this.revision;this.setBusy(true,'Сравниваю 5 вариантов композиции…');
    const image=this.image;
    try {
      let winner=null;
      for(const position of [.5,.25,.75,0,1]) {
        if(rev!==this.revision)return;
        const rect=cropRect(image.naturalWidth,image.naturalHeight,this.ratio,position);
        const canvas=this.sourceCanvas(448,200704,rect);
        const ctx=canvas.getContext('2d',{willReadFrequently:true});
        const raw=ctx.getImageData(0,0,canvas.width,canvas.height);
        const pixels=await this.processor.process(raw,{...this.edit});
        ctx.putImageData(new ImageData(pixels,canvas.width,canvas.height),0,0);
        const score=await this.model.score(canvas);
        if(!winner || score.mean>winner.score.mean+.06) winner={score,position};
      }
      if(rev!==this.revision)return;
      this.position=winner.position;this.base=null;this.finalScore=winner.score;
      this.sync();await this.render();
      $('editor-score').textContent='Композиция · NIMA '+winner.score.mean.toFixed(2)+' / 10';
      this.toast('Выбрана обрезка. Проверь, что важные детали остались в кадре.');
    } catch(_) {if(rev===this.revision)this.toast('Подбор ИИ недоступен. Положение обрезки можно изменить вручную.');}
    finally {if(rev===this.revision){this.setBusy(false);this.sync();}}
  }
  async save() {
    if(!this.image || this.busy)return;
    const rev=this.revision, photo=this.photo, edit={...this.edit};
    const recipe={...edit,ratio:this.ratio,position:this.position},aesthetic=this.finalScore || null;
    this.setBusy(true,'Готовлю JPEG в высоком разрешении…');
    let canvas;
    try {
      await tick();
      canvas=this.sourceCanvas(4096,16000000);
      const ctx=canvas.getContext('2d',{willReadFrequently:true});
      const raw=ctx.getImageData(0,0,canvas.width,canvas.height);
      const pixels=await this.processor.process(raw,edit);
      ctx.putImageData(new ImageData(pixels,canvas.width,canvas.height),0,0);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.95));
      if(!blob)throw new Error('Не удалось создать JPEG');
      const entry={...photo,id:crypto.randomUUID(),blob,date:Date.now(),label:photo.label+' · '+PRESETS[edit.preset].label,
        edited:true,score:null,aesthetic,recipe,
        width:canvas.width,height:canvas.height};
      let stored=true;
      try {await this.onSave(entry);} catch(_){stored=false;}
      const link=document.createElement('a'),url=URL.createObjectURL(blob);
      link.href=url;link.download='photo-scout-'+Date.now()+'.jpg';link.click();
      setTimeout(()=>URL.revokeObjectURL(url),60000);
      this.toast(stored?'Копия сохранена в плёнку и передана в загрузки':'JPEG передан в загрузки. В хранилище браузера не хватило места.');
    } catch(error){this.toast(error.message || 'Не удалось сохранить');}
    finally {
      if(canvas){canvas.width=canvas.height=1;}
      if(rev===this.revision){this.setBusy(false);this.sync();}
    }
  }
}
