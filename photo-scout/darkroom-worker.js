import { processPixels } from './darkroom.js';
self.onmessage = ({ data }) => {
  try {
    const pixels = processPixels(new Uint8ClampedArray(data.buffer), data.width, data.height, data.edit);
    self.postMessage({ id:data.id, buffer:pixels.buffer }, [pixels.buffer]);
  } catch(error) { self.postMessage({ id:data.id, error:error.message }); }
};
