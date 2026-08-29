import { xenosFrameView } from './render360-webgpu-xenos.mjs';

const VS=`#version 300 es
precision highp float;
const vec2 P[3]=vec2[3](vec2(-1.0,-1.0),vec2(3.0,-1.0),vec2(-1.0,3.0));
out vec2 v_uv;
void main(){vec2 p=P[gl_VertexID];gl_Position=vec4(p,0.0,1.0);v_uv=(p+1.0)*0.5;}`;
const FS=`#version 300 es
precision highp float;
uniform sampler2D u_frame;
in vec2 v_uv;
out vec4 out_color;
void main(){out_color=texture(u_frame,vec2(v_uv.x,1.0-v_uv.y));}`;
function shader(gl,type,source){const s=gl.createShader(type);if(!s)throw new Error('WebGL2 shader allocation failed');gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){const log=gl.getShaderInfoLog(s)||'shader compile failed';gl.deleteShader(s);throw new Error(log);}return s;}
function program(gl){const p=gl.createProgram();if(!p)throw new Error('WebGL2 program allocation failed');const vs=shader(gl,gl.VERTEX_SHADER,VS),fs=shader(gl,gl.FRAGMENT_SHADER,FS);gl.attachShader(p,vs);gl.attachShader(p,fs);gl.linkProgram(p);gl.deleteShader(vs);gl.deleteShader(fs);if(!gl.getProgramParameter(p,gl.LINK_STATUS)){const log=gl.getProgramInfoLog(p)||'program link failed';gl.deleteProgram(p);throw new Error(log);}return p;}
export function createXenosWebGL2Presenter(canvas,instance){const gl=canvas?.getContext?.('webgl2',{alpha:false,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false});if(!gl)throw new Error('WebGL2 unavailable');const p=program(gl),vao=gl.createVertexArray(),tex=gl.createTexture();if(!vao||!tex)throw new Error('WebGL2 resource allocation failed');gl.bindVertexArray(vao);gl.useProgram(p);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,tex);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);const loc=gl.getUniformLocation(p,'u_frame');if(loc!==null)gl.uniform1i(loc,0);let lastGeneration=0xFFFFFFFF,lastWidth=0,lastHeight=0;return {gl,present(){const frame=xenosFrameView(instance);if(!frame.width||!frame.height||!frame.size)throw new Error('empty Xenos frame');if(canvas.width!==frame.width)canvas.width=frame.width;if(canvas.height!==frame.height)canvas.height=frame.height;gl.viewport(0,0,canvas.width,canvas.height);gl.useProgram(p);gl.bindVertexArray(vao);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,tex);if(frame.generation!==lastGeneration||frame.width!==lastWidth||frame.height!==lastHeight){gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,frame.width,frame.height,0,gl.RGBA,gl.UNSIGNED_BYTE,frame.rgba);lastGeneration=frame.generation;lastWidth=frame.width;lastHeight=frame.height;}gl.drawArrays(gl.TRIANGLES,0,3);return frame;},destroy(){gl.deleteTexture(tex);gl.deleteVertexArray(vao);gl.deleteProgram(p);}};}
