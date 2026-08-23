export class WebGraphicsHost {
  constructor(canvas, log, onStats) {
    this.canvas = canvas;
    this.log = log;
    this.onStats = onStats;
    this.backend = 'none';
    this.device = null;
    this.context = null;
    this.gl = null;
    this.pipeline = null;
    this.bindGroup = null;
    this.uniformBuffer = null;
    this.glProgram = null;
    this.glTime = null;
    this.glAspect = null;
    this.raf = 0;
    this.frames = 0;
    this.lastReport = performance.now();
    this.lastFrame = 0;
    this.renderScale = 1.0;
    this.minRenderScale = 0.5;
    this.maxRenderScale = 1.0;
    this.autoScale = true;
    this.targetFps = 30;
    this.stableSeconds = 0;
  }

  async init() {
    if ('gpu' in navigator) {
      try {
        const adapter = await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
        if (!adapter) throw new Error('No WebGPU adapter');
        this.device = await adapter.requestDevice();
        this.device.lost.then(info => this.log('error', `WebGPU device lost · ${info.message || info.reason}`));
        this.context = this.canvas.getContext('webgpu');
        if (!this.context) throw new Error('Canvas WebGPU context unavailable');
        const format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({device:this.device, format, alphaMode:'premultiplied'});
        this.initWebGpuPipeline(format);
        this.backend = 'webgpu';
        this.log('ok', `WebGPU shader pipeline active · ${format}`);
        this.start();
        return this.backend;
      } catch (e) {
        this.log('warn', `WebGPU unavailable: ${e.message}`);
      }
    }

    this.gl = this.canvas.getContext('webgl2', {alpha:true, antialias:false, preserveDrawingBuffer:false, powerPreference:'high-performance'});
    if (this.gl) {
      this.initWebGlPipeline();
      this.backend = 'webgl2';
      this.log('warn', 'WebGL2 animated diagnostic fallback active; emulator target remains WebGPU');
      this.start();
      return this.backend;
    }
    throw new Error('Neither WebGPU nor WebGL2 is available');
  }

  initWebGpuPipeline(format) {
    const shader = this.device.createShaderModule({code:`
struct Params { time:f32, aspect:f32, activity:f32, pad:f32 };
@group(0) @binding(0) var<uniform> params: Params;
struct VSOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) index:u32) -> VSOut {
  var p = array<vec2f,3>(vec2f(-1.0,-1.0), vec2f(3.0,-1.0), vec2f(-1.0,3.0));
  var out:VSOut;
  out.position = vec4f(p[index],0.0,1.0);
  out.uv = p[index] * 0.5 + vec2f(0.5);
  return out;
}
@fragment fn fs(in:VSOut) -> @location(0) vec4f {
  let q = in.uv - vec2f(0.5);
  let d = length(vec2f(q.x * params.aspect, q.y));
  let wave = 0.5 + 0.5 * sin(params.time * 1.15 - d * 17.0);
  let halo = exp(-d * 5.0) * (0.20 + 0.18 * wave);
  let scan = 0.5 + 0.5 * sin((in.uv.y + params.time * 0.025) * 120.0);
  return vec4f(0.004 + halo * 0.05, 0.008 + halo * 0.22, 0.013 + halo * 0.16 + scan * 0.0025, 1.0);
}`});
    this.uniformBuffer = this.device.createBuffer({size:16, usage:GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
    this.pipeline = this.device.createRenderPipeline({
      layout:'auto',
      vertex:{module:shader, entryPoint:'vs'},
      fragment:{module:shader, entryPoint:'fs', targets:[{format}]},
      primitive:{topology:'triangle-list'}
    });
    this.bindGroup = this.device.createBindGroup({
      layout:this.pipeline.getBindGroupLayout(0),
      entries:[{binding:0, resource:{buffer:this.uniformBuffer}}]
    });
  }

  compileGl(type, source) {
    const gl=this.gl, shader=gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'WebGL shader compile failed');
    return shader;
  }

  initWebGlPipeline() {
    const gl=this.gl;
    const vs=this.compileGl(gl.VERTEX_SHADER,`#version 300 es\nprecision highp float;\nout vec2 uv;\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);uv=p;gl_Position=vec4(p*2.0-1.0,0.0,1.0);}`);
    const fs=this.compileGl(gl.FRAGMENT_SHADER,`#version 300 es\nprecision highp float;\nin vec2 uv;out vec4 color;uniform float time;uniform float aspect;\nvoid main(){vec2 q=uv-0.5;float d=length(vec2(q.x*aspect,q.y));float wave=0.5+0.5*sin(time*1.15-d*17.0);float halo=exp(-d*5.0)*(0.20+0.18*wave);color=vec4(0.004+halo*0.05,0.008+halo*0.22,0.013+halo*0.16,1.0);}`);
    const program=gl.createProgram(); gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program)||'WebGL program link failed');
    this.glProgram=program;this.glTime=gl.getUniformLocation(program,'time');this.glAspect=gl.getUniformLocation(program,'aspect');
  }

  resize() {
    const rect=this.canvas.getBoundingClientRect();
    const dpr=Math.min(devicePixelRatio||1,1.5) * this.renderScale;
    const w=Math.max(1,Math.floor(rect.width*dpr)),h=Math.max(1,Math.floor(rect.height*dpr));
    if(this.canvas.width!==w||this.canvas.height!==h){this.canvas.width=w;this.canvas.height=h}
  }

  frame = (now) => {
    const interval = 1000 / Math.max(1, this.targetFps);
    if (this.lastFrame && now - this.lastFrame < interval * 0.92) {
      this.raf=requestAnimationFrame(this.frame);
      return;
    }
    this.lastFrame = now;
    this.resize();
    const time=now*0.001, aspect=this.canvas.width/Math.max(1,this.canvas.height);
    if(this.backend==='webgpu'){
      this.device.queue.writeBuffer(this.uniformBuffer,0,new Float32Array([time,aspect,1,0]));
      const encoder=this.device.createCommandEncoder();
      const pass=encoder.beginRenderPass({colorAttachments:[{view:this.context.getCurrentTexture().createView(),clearValue:{r:0.002,g:0.004,b:0.007,a:1},loadOp:'clear',storeOp:'store'}]});
      pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.bindGroup);pass.draw(3);pass.end();
      this.device.queue.submit([encoder.finish()]);
    }else if(this.gl){
      const gl=this.gl;gl.viewport(0,0,this.canvas.width,this.canvas.height);gl.useProgram(this.glProgram);gl.uniform1f(this.glTime,time);gl.uniform1f(this.glAspect,aspect);gl.drawArrays(gl.TRIANGLES,0,3);
    }
    this.frames++;
    const elapsed=now-this.lastReport;
    if(elapsed>=1000){
      const fps=this.frames*1000/elapsed;
      if(this.autoScale){
        if(fps < this.targetFps*0.88 && this.renderScale > this.minRenderScale){
          this.renderScale=Math.max(this.minRenderScale,Math.round((this.renderScale-0.10)*100)/100);
          this.stableSeconds=0;
        }else if(fps >= this.targetFps*0.97){
          this.stableSeconds++;
          if(this.stableSeconds>=4 && this.renderScale < this.maxRenderScale){
            this.renderScale=Math.min(this.maxRenderScale,Math.round((this.renderScale+0.05)*100)/100);
            this.stableSeconds=0;
          }
        }else{this.stableSeconds=0}
      }
      this.onStats?.({fps,backend:this.backend,renderScale:this.renderScale,targetFps:this.targetFps});this.frames=0;this.lastReport=now
    }
    this.raf=requestAnimationFrame(this.frame);
  };

  setPerformance({targetFps=30,autoScale=true,minScale=0.5,maxScale=1,scale=this.renderScale}={}){
    this.targetFps=Math.max(15,Math.min(60,Number(targetFps)||30));
    this.autoScale=!!autoScale;
    this.minRenderScale=Math.max(0.35,Math.min(1,Number(minScale)||0.5));
    this.maxRenderScale=Math.max(this.minRenderScale,Math.min(1,Number(maxScale)||1));
    this.renderScale=Math.max(this.minRenderScale,Math.min(this.maxRenderScale,Number(scale)||this.maxRenderScale));
    this.stableSeconds=0;
  }
  start(){cancelAnimationFrame(this.raf);this.lastFrame=0;this.raf=requestAnimationFrame(this.frame)}
  stop(){cancelAnimationFrame(this.raf)}
}
