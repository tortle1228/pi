# apply_patch

The files in this directory, except `index.ts`, are ported from senpi's `gpt-apply-patch` built-in extension
(https://github.com/code-yeongyu/senpi, `packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch`, commit
`952a3b0051`). Changes: imports point to pi's modules, the tool carries its Lark grammar in `constrainedSampling` instead
of a separate freeform variant, senpi's model-gated tool switching is left out, and the unified-patch helper is local to
`preview.ts`.

```
MIT License

Copyright (c) 2025 Mario Zechner (upstream pi-mono)
Copyright (c) 2026 Yeongyu Kim and senpi contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
