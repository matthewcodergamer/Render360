export class ThreeDiagnosticHost {
  constructor(canvas, log, onStats, onGameStats) {
    this.canvas = canvas;
    this.log = log;
    this.onStats = onStats;
    this.onGameStats = onGameStats;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.THREE = null;
    this.portal = null;
    this.player = null;
    this.playerShadow = null;
    this.raf = 0;
    this.running = false;
    this.playing = false;
    this.frames = 0;
    this.lastReport = performance.now();
    this.lastFrame = 0;
    this.lastGameReport = 0;
    this.input = {lx:0, ly:0, sprint:false};
    this.yaw = 0;
    this.pitch = -0.20;
    this.velocityY = 0;
    this.grounded = true;
    this.score = 0;
    this.pickups = [];
    this.worldRadius = 18;
  }

  async init() {
    try {
      const THREE = await import('https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.min.js');
      this.THREE = THREE;
      this.renderer = new THREE.WebGLRenderer({canvas:this.canvas, alpha:true, antialias:false, powerPreference:'high-performance'});
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
      this.scene = new THREE.Scene();
      this.scene.fog = new THREE.Fog(0x071017, 15, 38);
      this.camera = new THREE.PerspectiveCamera(55, 1, 0.08, 80);

      const hemi = new THREE.HemisphereLight(0xbfe8ff, 0x07100a, 1.45);
      const sun = new THREE.DirectionalLight(0xffffff, 1.65);
      sun.position.set(6, 12, 4);
      this.scene.add(hemi, sun);

      const floorMat = new THREE.MeshStandardMaterial({color:0x10181c, roughness:.92, metalness:.04});
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(44,44,1,1), floorMat);
      floor.rotation.x = -Math.PI/2;
      this.scene.add(floor);

      const grid = new THREE.GridHelper(44, 44, 0x355d50, 0x1d302c);
      grid.position.y = 0.012;
      this.scene.add(grid);

      const obstacleMat = new THREE.MeshStandardMaterial({color:0x25333c, roughness:.62, metalness:.18});
      const accentMat = new THREE.MeshStandardMaterial({color:0x3a6a57, emissive:0x10271d, roughness:.45});
      const obstacleData = [
        [-7,.75,-6,3,1.5,2], [7,1.1,-5,2.2,2.2,3.4], [-5,1.5,5,2,3,2],
        [5,.55,6,4,1.1,1.4], [0,.45,-9,5,.9,1.4], [10,.8,2,1.7,1.6,4]
      ];
      obstacleData.forEach((o,i)=>{
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(o[3],o[4],o[5]), i%2?accentMat:obstacleMat);
        mesh.position.set(o[0],o[1],o[2]);
        this.scene.add(mesh);
      });

      const portalMat = new THREE.MeshStandardMaterial({color:0x76e8a8, emissive:0x163e2a, metalness:.5, roughness:.24, wireframe:true, transparent:true, opacity:.74});
      this.portal = new THREE.Mesh(new THREE.TorusKnotGeometry(1.05,.23,96,12,2,3), portalMat);
      this.portal.position.set(0,2.15,0);
      this.scene.add(this.portal);

      this.player = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(.34,.85,5,10), new THREE.MeshStandardMaterial({color:0xdce8e3, roughness:.45, metalness:.08}));
      body.position.y = .78;
      const visor = new THREE.Mesh(new THREE.BoxGeometry(.36,.16,.06), new THREE.MeshBasicMaterial({color:0x6de0a1}));
      visor.position.set(0,1.16,-.31);
      this.player.add(body, visor);
      this.player.position.set(0,0,6);
      this.scene.add(this.player);

      this.playerShadow = new THREE.Mesh(new THREE.CircleGeometry(.48,24), new THREE.MeshBasicMaterial({color:0x000000,transparent:true,opacity:.32,depthWrite:false}));
      this.playerShadow.rotation.x = -Math.PI/2;
      this.playerShadow.position.set(0,.018,6);
      this.scene.add(this.playerShadow);

      const pickupGeo = new THREE.OctahedronGeometry(.28,0);
      const pickupMat = new THREE.MeshStandardMaterial({color:0x8edcff,emissive:0x123c55,metalness:.4,roughness:.2});
      [[-9,-8],[-8,8],[8,-8],[9,8],[0,-13],[13,0]].forEach(([x,z],i)=>{
        const p = new THREE.Mesh(pickupGeo,pickupMat.clone());
        p.position.set(x,.65,z); p.userData.baseY=.65; p.userData.phase=i*.83; p.userData.collected=false;
        this.pickups.push(p); this.scene.add(p);
      });

      this.camera.position.set(0,3.0,10);
      this.running = true;
      this.log('ok', `Three.js ${THREE.REVISION} playable arena renderer active`);
      this.raf = requestAnimationFrame(this.frame);
      return {revision:THREE.REVISION, backend:'webgl'};
    } catch (error) {
      this.log('warn', `Three.js arena unavailable: ${error?.message || error}`);
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

  setPlaying(value) {
    this.playing = !!value;
    this.canvas.classList.toggle('arena-playing', this.playing);
    if (this.playing) this.start();
  }

  setMove(x,y){
    const len=Math.hypot(x,y);
    if(len>1){x/=len;y/=len}
    this.input.lx=Number.isFinite(x)?x:0;
    this.input.ly=Number.isFinite(y)?y:0;
  }
  setSprint(v){this.input.sprint=!!v}
  lookDelta(dx,dy){
    this.yaw -= dx * 0.0045;
    this.pitch = Math.max(-0.72, Math.min(0.38, this.pitch - dy * 0.0038));
  }
  jump(){if(this.playing && this.grounded){this.velocityY=5.8;this.grounded=false}}
  resetPlayer(){
    if(!this.player)return;
    this.player.position.set(0,0,6);this.velocityY=0;this.grounded=true;this.score=0;
    for(const p of this.pickups){p.visible=true;p.userData.collected=false}
    this.onGameStats?.({score:this.score,x:0,z:6,playing:this.playing});
  }

  updateGame(dt, now){
    if(!this.player || !this.playing) return;
    const THREE=this.THREE;
    const speed=(this.input.sprint?6.5:3.8);
    const forward = new THREE.Vector3(-Math.sin(this.yaw),0,-Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw),0,-Math.sin(this.yaw));
    const move = new THREE.Vector3();
    move.addScaledVector(right,this.input.lx);
    move.addScaledVector(forward,-this.input.ly);
    if(move.lengthSq()>1)move.normalize();
    if(move.lengthSq()>.002){
      move.normalize().multiplyScalar(speed*dt);
      this.player.position.add(move);
      const targetYaw=Math.atan2(move.x,move.z);
      let d=((targetYaw-this.player.rotation.y+Math.PI)%(Math.PI*2))-Math.PI;
      this.player.rotation.y += d*Math.min(1,dt*10);
    }
    const r=this.worldRadius;
    this.player.position.x=Math.max(-r,Math.min(r,this.player.position.x));
    this.player.position.z=Math.max(-r,Math.min(r,this.player.position.z));

    this.velocityY -= 15.5*dt;
    this.player.position.y += this.velocityY*dt;
    if(this.player.position.y<=0){this.player.position.y=0;this.velocityY=0;this.grounded=true}
    this.playerShadow.position.set(this.player.position.x,.018,this.player.position.z);
    this.playerShadow.material.opacity=.34*Math.max(.25,1-this.player.position.y/4);

    for(const p of this.pickups){
      if(p.userData.collected)continue;
      p.rotation.y += dt*1.8;p.rotation.x += dt*.7;
      p.position.y=p.userData.baseY+Math.sin(now*.002+p.userData.phase)*.14;
      const dx=p.position.x-this.player.position.x,dz=p.position.z-this.player.position.z;
      if(dx*dx+dz*dz<1.05){p.userData.collected=true;p.visible=false;this.score++}
    }
    if(this.score===this.pickups.length && this.pickups.length){
      this.portal.material.opacity=.98;
    }else if(this.portal){this.portal.material.opacity=.74}

    if(now-this.lastGameReport>180){
      this.lastGameReport=now;
      this.onGameStats?.({score:this.score,x:this.player.position.x,z:this.player.position.z,playing:true});
    }
  }

  updateCamera(dt){
    if(!this.player)return;
    const target=this.player.position.clone();target.y+=.85;
    const distance=this.playing?5.6:7.4;
    const cp=Math.cos(this.pitch),sp=Math.sin(this.pitch);
    const desired = new this.THREE.Vector3(
      target.x + Math.sin(this.yaw)*cp*distance,
      target.y + 2.0 + sp*distance,
      target.z + Math.cos(this.yaw)*cp*distance
    );
    this.camera.position.lerp(desired,1-Math.pow(.001,dt));
    this.camera.lookAt(target);
  }

  frame = (now) => {
    if (!this.running) return;
    const rawDt=this.lastFrame?Math.min(.05,(now-this.lastFrame)/1000):1/60;
    this.lastFrame=now;
    this.resize();
    this.updateGame(rawDt,now);
    this.updateCamera(rawDt);
    if(this.portal){
      this.portal.rotation.x=now*.00017;
      this.portal.rotation.y=now*.00028;
      this.portal.scale.setScalar(1+Math.sin(now*.0011)*.025);
    }
    this.renderer.render(this.scene,this.camera);
    this.frames++;
    const elapsed=now-this.lastReport;
    if(elapsed>=1000){
      this.onStats?.({fps:this.frames*1000/elapsed,playing:this.playing});
      this.frames=0;this.lastReport=now;
    }
    this.raf=requestAnimationFrame(this.frame);
  };
  start(){if(!this.renderer||this.running)return;this.running=true;this.lastFrame=0;this.lastReport=performance.now();this.frames=0;this.raf=requestAnimationFrame(this.frame)}
  setEnabled(enabled){if(enabled)this.start();else this.stop();this.canvas.style.display=enabled?'block':'none'}
  stop(){this.running=false;cancelAnimationFrame(this.raf)}
}
