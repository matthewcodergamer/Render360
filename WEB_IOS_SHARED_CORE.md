# Web + iOS shared-core direction

Render360 should not finish a JavaScript emulator and later rewrite it for iOS. The long-term architecture is one portable C++ Xbox core with thin platform adapters.

```text
                         Render360 portable C++ core
            XEX / STFS / VFS / memory / PPC / kernel / Xenos
                                  |
                   +--------------+--------------+
                   |                             |
             Render360 Web                  Render360 iOS
             C++ -> WASM                     native C++/ARM64
             WebGPU                          Metal
             WebAudio                        CoreAudio
             Web Workers                     native threading
             Web/Gamepad input               GameController
             HTML/CSS UI                     SwiftUI/UIKit
```

V30 is still a **web build only**. The iOS target is not included yet. The reason for keeping STFS/XEX logic out of JavaScript is to make future reuse possible and to avoid duplicating Xbox behavior in two frontends.

The WebGPU backend should eventually consume Xenia's shared Xenos command processing directly. Three.js is useful only for host diagnostics and must not sit in the emulation render path.
