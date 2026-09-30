/* NIMA AVA, idealo weights. Apache-2.0; see models/nima/LICENSE.
 * Original checkpoint was trained with Keras 2.1.6: all 3x3 convolutions
 * use symmetric one-pixel padding, including stride 2. Modern MobileNet
 * 'same' padding is NOT equivalent for those layers.
 */
let weights, loading;
const send = (message) => self.postMessage(message);
async function init() {
  importScripts('./vendor/tf.min.js', './vendor/tf-backend-wasm.js');
  tf.wasm.setWasmPaths(new URL('./vendor/', self.location.href).href);
  tf.wasm.setThreadsCount(1);
  tf.env().set('WASM_HAS_MULTITHREAD_SUPPORT', false);
  try { await tf.setBackend('wasm'); await tf.ready(); }
  catch (_) { await tf.setBackend('cpu'); await tf.ready(); }
  const [metaResponse, dataResponse] = await Promise.all([
    fetch('./models/nima/manifest.json'), fetch('./models/nima/weights.bin')
  ]);
  if (!metaResponse.ok || !dataResponse.ok) throw new Error('Файлы NIMA недоступны');
  const manifest = await metaResponse.json();
  const buffer = await dataResponse.arrayBuffer();
  if (crypto.subtle) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
    const hash = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
    if (hash !== manifest.weightsSHA256) throw new Error('Повреждены веса NIMA');
  }
  weights = {};
  for (const item of manifest.weights) {
    weights[item.name] = tf.tensor(new Float32Array(buffer, item.offset, item.length), item.shape);
  }
  return { backend: tf.getBackend(), model: manifest.name };
}
function predict(rgb) {
  return tf.tidy(() => {
    const w = (name) => weights[name];
    const norm = (x, name) => tf.clipByValue(tf.batchNorm(x,
      w(name + '/moving_mean'), w(name + '/moving_variance'),
      w(name + '/beta'), w(name + '/gamma'), 0.001), 0, 6);
    const pad = (x) => tf.pad(x, [[0,0],[1,1],[1,1],[0,0]]);
    let x = tf.tensor4d(rgb, [1,224,224,3], 'float32').div(127.5).sub(1);
    x = norm(tf.conv2d(pad(x), w('conv1/kernel'), 2, 'valid'), 'conv1_bn');
    for (let i = 1; i <= 13; i++) {
      const stride = [2,4,6,12].includes(i) ? 2 : 1;
      x = norm(tf.depthwiseConv2d(pad(x), w('conv_dw_' + i + '/depthwise_kernel'),
        stride, 'valid'), 'conv_dw_' + i + '_bn');
      x = norm(tf.conv2d(x, w('conv_pw_' + i + '/kernel'), 1, 'same'), 'conv_pw_' + i + '_bn');
    }
    const logits = tf.matMul(x.mean([1,2]), w('dense_1/kernel')).add(w('dense_1/bias'));
    return tf.softmax(logits).reshape([10]);
  });
}
self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    loading ||= init();
    const info = await loading;
    if (type === 'init') return send({ id, result: info });
    const start = performance.now();
    const tensor = predict(new Uint8Array(data.rgb));
    let probabilities;
    try { probabilities = Array.from(await tensor.data()); } finally { tensor.dispose(); }
    if (!probabilities.every(Number.isFinite)) throw new Error('Некорректный результат NIMA');
    const mean = probabilities.reduce((sum, p, i) => sum + p * (i + 1), 0);
    const spread = Math.sqrt(probabilities.reduce((sum, p, i) => sum + p * (i + 1 - mean) ** 2, 0));
    send({ id, result: { mean, spread, probabilities, ms: performance.now() - start } });
  } catch (error) { send({ id, error: error.message || 'NIMA недоступна' }); }
};
