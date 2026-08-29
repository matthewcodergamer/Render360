const td=new TextDecoder('utf-8',{fatal:false});
const te=new TextEncoder();

function bytesFrom(value,encoding='utf8'){
  if(value instanceof R360Buffer)return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
  if(value instanceof Uint8Array)return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
  if(ArrayBuffer.isView(value))return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
  if(value instanceof ArrayBuffer)return new Uint8Array(value);
  if(typeof value==='string'){
    if(encoding==='ascii'||encoding==='latin1'){const out=new Uint8Array(value.length);for(let i=0;i<value.length;i++)out[i]=value.charCodeAt(i)&255;return out;}
    return te.encode(value);
  }
  if(Array.isArray(value))return Uint8Array.from(value);
  throw new TypeError('unsupported byte-buffer source');
}

export class R360Buffer extends Uint8Array{
  static from(value,encoding='utf8'){const src=bytesFrom(value,encoding);const out=new R360Buffer(src.length);out.set(src);return out;}
  static alloc(size,fill=0){if(!Number.isSafeInteger(size)||size<0)throw new RangeError('invalid buffer size');const out=new R360Buffer(size);if(fill)out.fill(fill);return out;}
  static concat(list,totalLength=null){
    if(!Array.isArray(list))throw new TypeError('buffer list required');
    const n=totalLength===null?list.reduce((a,b)=>a+b.length,0):Number(totalLength);
    if(!Number.isSafeInteger(n)||n<0)throw new RangeError('invalid concatenated buffer size');
    const out=new R360Buffer(n);let off=0;for(const item of list){const b=bytesFrom(item);const take=Math.min(b.length,n-off);if(take<=0)break;out.set(b.subarray(0,take),off);off+=take;}return out;
  }
  readUInt16BE(offset){if(offset<0||offset+2>this.length)throw new RangeError('readUInt16BE out of bounds');return ((this[offset]<<8)|this[offset+1])>>>0;}
  readUInt32BE(offset){if(offset<0||offset+4>this.length)throw new RangeError('readUInt32BE out of bounds');return ((this[offset]<<24)|(this[offset+1]<<16)|(this[offset+2]<<8)|this[offset+3])>>>0;}
  writeUInt16BE(value,offset){if(offset<0||offset+2>this.length)throw new RangeError('writeUInt16BE out of bounds');this[offset]=(value>>>8)&255;this[offset+1]=value&255;return offset+2;}
  toString(encoding='utf8',start=0,end=this.length){const s=Math.max(0,start|0),e=Math.min(this.length,end|0),v=this.subarray(s,e);if(encoding==='ascii'||encoding==='latin1'){let out='';for(const b of v)out+=String.fromCharCode(b);return out;}return td.decode(v);}
}

export const Buffer=R360Buffer;
export function installRender360Buffer(){if(typeof globalThis.Buffer==='undefined')globalThis.Buffer=R360Buffer;return globalThis.Buffer;}
installRender360Buffer();
