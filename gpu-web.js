export class WebGraphicsHost {
  constructor(canvas, log) { this.canvas = canvas; this.log = log; this.backend = 'none'; this.device = null; this.context = null; this.gl = null; this.raf = 0; }
  async init() {
    if ('gpu' in navigator) {
      try {
        const adapter = await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
        if (!adapter) throw new Error('No WebGPU adapter');
        this.device = await adapter.requestDevice();
        this.context = this.canvas.getContext('webgpu');
        if (!this.context) throw new Error('Canvas WebGPU context unavailable');
        const format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({device:this.device, format, alphaMode:'premultiplied'});
        this.backend = 'webgpu';
        this.log('ok', `WebGPU device ready · ${format}`);
        this.start();
        return this.backend;
      } catch (e) { this.log('warn', `WebGPU unavailable: ${e.message}`); }
    }
    this.gl = this.canvas.getContext('webgl2', {alpha:true, antialias:false, preserveDrawingBuffer:false});
    if (this.gl) {
      this.backend = 'webgl2';
      this.log('warn', 'Using WebGL2 diagnostic fallback; emulator target remains WebGPU');
      this.start();
      return this.backend;
    }
    throw new Error('Neither WebGPU nor WebGL2 is available');
  }
  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(innerWidth * dpr));
    const h = Math.max(1, Math.floor(innerHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }
  frame = () => {
    this.resize();
    const t = performance.now() * 0.00012;
    if (this.backend === 'webgpu') {
      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({colorAttachments:[{view:this.context.getCurrentTexture().createView(), clearValue:{r:0.008+Math.sin(t)*0.003,g:0.012,b:0.02+Math.cos(t)*0.004,a:1}, loadOp:'clear', storeOp:'store'}]});
      pass.end();
      this.device.queue.submit([encoder.finish()]);
    } else if (this.gl) {
      this.gl.viewport(0,0,this.canvas.width,this.canvas.height);
      this.gl.clearColor(0.008,0.012,0.02,1);
      this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    }
    this.raf = requestAnimationFrame(this.frame);
  };
  start() { cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(this.frame); }
}
