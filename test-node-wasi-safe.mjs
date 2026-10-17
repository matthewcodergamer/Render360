// Import first in tests that run the bootstrap under node:wasi.
//
// Node 22's WASI fd_write fast-API callback allocates (uvwasi) and reports
// external memory to V8, which can start a garbage collection inside the fast
// call; V8 then crashes walking an optimized frame (SIGSEGV in
// InnerPointerToCodeCache::GetCacheEntry). Guest stderr output under heap
// pressure triggers it. Fast API calls off keeps WASI calls on the regular
// path, where GC is allowed.
import v8 from 'node:v8';
v8.setFlagsFromString('--no-turbo-fast-api-calls');
