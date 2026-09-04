from pathlib import Path

p=Path('src/xenia_web_bootstrap/kernel_runtime_foundation.cpp')
s=p.read_text()
if 'r360_kernel_input_set_mask' not in s:
    marker='uint32_t g_next_notify_handle = 0x37000001u;\n'
    add='''uint32_t g_next_notify_handle = 0x37000001u;
uint32_t g_input_mask = 0;
uint32_t g_input_packet = 1;
int32_t g_input_lx = 0, g_input_ly = 0, g_input_rx = 0, g_input_ry = 0;

void StoreInputBE16(uint8_t* p, uint16_t v) { p[0]=uint8_t(v>>8); p[1]=uint8_t(v); }
void StoreInputBE32(uint8_t* p, uint32_t v) { p[0]=uint8_t(v>>24); p[1]=uint8_t(v>>16); p[2]=uint8_t(v>>8); p[3]=uint8_t(v); }
uint16_t BrowserInputButtons() {
  uint16_t b=0;
  if(g_input_mask&(1u<<0)) b|=0x1000u; if(g_input_mask&(1u<<1)) b|=0x2000u;
  if(g_input_mask&(1u<<2)) b|=0x4000u; if(g_input_mask&(1u<<3)) b|=0x8000u;
  if(g_input_mask&(1u<<6)) b|=0x0100u; if(g_input_mask&(1u<<7)) b|=0x0200u;
  if(g_input_mask&(1u<<8)) b|=0x0010u; if(g_input_mask&(1u<<9)) b|=0x0020u;
  return b;
}
bool WriteBrowserInputState(uint32_t address) {
  std::array<uint8_t,16> v{};
  StoreInputBE32(v.data(),g_input_packet); StoreInputBE16(v.data()+4,BrowserInputButtons());
  v[6]=(g_input_mask&(1u<<4))?0xFFu:0u; v[7]=(g_input_mask&(1u<<5))?0xFFu:0u;
  StoreInputBE16(v.data()+8,uint16_t(int16_t(g_input_lx))); StoreInputBE16(v.data()+10,uint16_t(int16_t(g_input_ly)));
  StoreInputBE16(v.data()+12,uint16_t(int16_t(g_input_rx))); StoreInputBE16(v.data()+14,uint16_t(int16_t(g_input_ry)));
  return WriteSparseGuestMemory(address,v.data(),v.size());
}
'''
    if marker not in s: raise SystemExit('input globals marker missing')
    s=s.replace(marker,add,1)
    s=s.replace('  g_scheduler_cursor = 0;\n  g_runtime_status = kStatusIdle;','  g_scheduler_cursor = 0;\n  g_input_mask = 0; g_input_packet = 1; g_input_lx = g_input_ly = g_input_rx = g_input_ry = 0;\n  g_runtime_status = kStatusIdle;',1)
    marker='''    switch (ordinal) {
      case 0x028A: {  // XamNotifyCreateListener'''
    add='''    switch (ordinal) {
      case 0x0190: {  // XamInputGetCapabilities
        if(!r5){g_service_status=kStatusInvalid;return 87u;}
        std::array<uint8_t,20> caps{}; caps[0]=1u; caps[1]=1u;
        if(!WriteSparseGuestMemory(r5,caps.data(),caps.size())){g_service_status=kStatusInvalid;return 87u;}
        return 0u;
      }
      case 0x0191: {  // XamInputGetState
        if(!r5) return 0u;
        if(!WriteBrowserInputState(r5)){g_service_status=kStatusInvalid;return 87u;}
        return 0u;
      }
      case 0x0192:  // XamInputSetState - vibration ignored for browser touch input.
        return 0u;
      case 0x028A: {  // XamNotifyCreateListener'''
    if marker not in s: raise SystemExit('XAM switch marker missing')
    s=s.replace(marker,add,1)
    marker='void r360_kernel_service_reset() {\n'
    add='''R360_WASM_EXPORT("r360_kernel_input_set_mask")
void r360_kernel_input_set_mask(uint32_t mask) {
  if(render360::xenia_web::g_input_mask!=mask){render360::xenia_web::g_input_mask=mask;++render360::xenia_web::g_input_packet;if(!render360::xenia_web::g_input_packet)render360::xenia_web::g_input_packet=1;}
}
R360_WASM_EXPORT("r360_kernel_input_set_analog")
void r360_kernel_input_set_analog(int32_t lx,int32_t ly,int32_t rx,int32_t ry) {
  auto c=[](int32_t v){return v<-32768?-32768:(v>32767?32767:v);}; lx=c(lx);ly=c(ly);rx=c(rx);ry=c(ry);
  if(render360::xenia_web::g_input_lx!=lx||render360::xenia_web::g_input_ly!=ly||render360::xenia_web::g_input_rx!=rx||render360::xenia_web::g_input_ry!=ry){render360::xenia_web::g_input_lx=lx;render360::xenia_web::g_input_ly=ly;render360::xenia_web::g_input_rx=rx;render360::xenia_web::g_input_ry=ry;++render360::xenia_web::g_input_packet;if(!render360::xenia_web::g_input_packet)render360::xenia_web::g_input_packet=1;}
}
R360_WASM_EXPORT("r360_kernel_input_mask")
uint32_t r360_kernel_input_mask(){return render360::xenia_web::g_input_mask;}

void r360_kernel_service_reset() {
'''
    if marker not in s: raise SystemExit('service export marker missing')
    s=s.replace(marker,add,1)
    p.write_text(s)

# Route the existing Render360 input state to the new title-WASM exports.
r=Path('runtime/render360-runtime.js'); t=r.read_text()
if 'syncGuestInput(){' not in t:
    old='''  setKey(key,pressed){this.inputHost.setKey(key,pressed);}
  setAnalog(lx=0,ly=0,rx=0,ry=0){this.inputHost.setAnalog(lx,ly,rx,ry);}'''
    new='''  syncGuestInput(){const e=globalThis.render360ModernTitle?.bootstrap?.exports;if(!e)return false;const sm=e.r360_kernel_input_set_mask||e._r360_kernel_input_set_mask,sa=e.r360_kernel_input_set_analog||e._r360_kernel_input_set_analog;if(typeof sm==='function')sm(this.inputHost.inputMask>>>0);if(typeof sa==='function'){const a=this.inputHost.analog||{},q=v=>Math.round(Math.max(-1,Math.min(1,Number(v)||0))*32767);sa(q(a.lx),q(-a.ly),q(a.rx),q(-a.ry));}return typeof sm==='function'||typeof sa==='function';}
  setKey(key,pressed){this.inputHost.setKey(key,pressed);this.syncGuestInput();}
  setAnalog(lx=0,ly=0,rx=0,ry=0){this.inputHost.setAnalog(lx,ly,rx,ry);this.syncGuestInput();}'''
    if old not in t: raise SystemExit('runtime input methods marker missing')
    t=t.replace(old,new,1)
    t=t.replace('  sampleTelemetry(){\n    const state=', '  sampleTelemetry(){\n    this.syncGuestInput();\n    const state=',1)
    r.write_text(t)

print('browser XInput bridge applied')
