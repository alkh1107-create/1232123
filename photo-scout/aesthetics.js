// The worker keeps inference off the camera/UI thread. No photo leaves this device.
export class AestheticModel {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.pending = new Map();
    this.sequence = 0;
    this.tail = Promise.resolve();
    this.failed = false;
    this.ms = 500;
  }
  load() {
    if (this.loading) return this.loading;
    this.onStatus('loading');
    this.loading = (async () => {
      this.worker = new Worker(new URL('./aesthetic-worker.js', import.meta.url));
      this.worker.onmessage = ({ data }) => {
        const job = this.pending.get(data.id);
        if (!job) return;
        clearTimeout(job.timer);
        this.pending.delete(data.id);
        data.error ? job.reject(new Error(data.error)) : job.resolve(data.result);
      };
      this.worker.onerror = () => this.fail(new Error('Не удалось запустить локальный ИИ'));
      const info = await this.request('init', {}, [], 120000);
      this.ready = true;
      this.onStatus('ready', info);
      return info;
    })().catch(error => { this.fail(error); throw error; });
    return this.loading;
  }
  fail(error) {
    this.failed = true;
    this.ready = false;
    this.worker?.terminate();
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(error); }
    this.pending.clear();
    this.onStatus('error', error);
  }
  request(type, data = {}, transfer = [], timeout = 45000) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => this.fail(new Error('ИИ не ответил вовремя')), timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ id, type, ...data }, transfer); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  score(source, crop = null) {
    // Snapshot now; a queued camera job must never read a later frame.
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 224;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,224,224);
    if (crop) ctx.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0,0,224,224);
    else ctx.drawImage(source, 0,0,224,224);
    const rgba = ctx.getImageData(0,0,224,224).data;
    const rgb = new Uint8Array(224 * 224 * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4) {
      rgb[j++] = rgba[i]; rgb[j++] = rgba[i + 1]; rgb[j++] = rgba[i + 2];
    }
    const run = async () => {
      await this.load();
      if (this.failed) throw new Error('ИИ недоступен. Перезагрузи страницу для повторной загрузки.');
      const result = await this.request('score', { rgb: rgb.buffer }, [rgb.buffer]);
      this.ms = result.ms;
      return result;
    };
    const result = this.tail.then(run);
    this.tail = result.catch(() => {});
    return result;
  }
}
