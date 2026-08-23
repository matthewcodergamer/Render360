export class ThreeDiagnosticHost {
  constructor(canvas, log, onStats) {
    this.canvas = canvas;
    this.log = log;
    this.onStats = onStats;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.mesh = null;
    this.raf = 0;
    this.running = false;
    this.frames = 0;
    this.lastReport = performance.now();
    this.lastFrame = 0;
  }
  async init() {
    try {
      const THREE = await import('https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.min.js');
      this.renderer = new THREE.WebGLRenderer({canvas:this.canvas, alpha:true, antialias:false, powerPreference:'high-performance'});
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.35));
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
      this.camera.position.z = 4.2;
      const geometry = new THREE.TorusKnotGeometry(0.72, 0.19, 72, 10, 2, 3);
      const material = new THREE.MeshBasicMaterial({color:0x6de0a1, wireframe:true, transparent:true, opacity:0.18});
      this.mesh = new THREE.Mesh(geometry, material);
      this.scene.add(this.mesh);
      this.running = true;
      this.log('ok', `Three.js ${THREE.REVISION} WebGL renderer active`);
      this.raf = requestAnimationFrame(this.frame);
      return {revision:THREE.REVISION, backend:'webgl'};
    } catch (error) {
      this.log('warn', `Three.js diagnostic unavailable: ${error?.message || error}`);
      throw error;
    }
  }
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  frame = (now) => {
    if (!this.running) return;
    // 30 FPS is enough for the diagnostic layer and saves battery on mobile.
    if (now - this.lastFrame >= 30) {
      this.lastFrame = now;
      this.resize();
      const t = now * 0.001;
      this.mesh.rotation.x = t * 0.24;
      this.mesh.rotation.y = t * 0.36;
      this.mesh.scale.setScalar(1 + Math.sin(t * 0.7) * 0.035);
      this.renderer.render(this.scene, this.camera);
      this.frames++;
    }
    const elapsed = now - this.lastReport;
    if (elapsed >= 1000) {
      this.onStats?.({fps:this.frames * 1000 / elapsed});
      this.frames = 0; this.lastReport = now;
    }
    this.raf = requestAnimationFrame(this.frame);
  };
  start(){if(!this.renderer||this.running)return;this.running=true;this.lastFrame=0;this.lastReport=performance.now();this.frames=0;this.raf=requestAnimationFrame(this.frame)}
  setEnabled(enabled){if(enabled)this.start();else this.stop();this.canvas.style.display=enabled?'block':'none'}
  stop(){this.running=false;cancelAnimationFrame(this.raf)}
}
