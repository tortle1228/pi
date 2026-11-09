# Visual feedback prototype

HTML + loopback HTTP server + waiting command. Node 22+, no dependencies, build, MCP, or Pi integration. The agent supplies all images; the user never uploads files in the browser.

| Mode | Flow |
|---|---|
| `choose` | Pick one of 2–4 designs → mark optional changes → submit |
| `annotate` | Open one image directly → mark optional changes → submit |
| `report` | Browse an agent-updated image list; optionally request changes to the image being viewed |

All use the compact B layout: large image plus a scrollable thumbnail list, with thumbnails below the image on narrow screens. Annotation shows a single image and a compact comments sidebar instead.

## Request files

The agent writes a JSON file. Relative image paths resolve from that file's directory. Text is displayed as text, not HTML. IDs are unique, 1–64 letters, digits, hyphens, or underscores; labels are required and at most 120 characters.

### Choose and optionally annotate

```json
{
  "mode": "choose",
  "question": "어떤 메뉴 배치로 진행할까요?",
  "options": [
    { "id": "top", "label": "상단 메뉴", "image": "top-menu.png" },
    { "id": "sidebar", "label": "사이드 메뉴", "image": "sidebar.png" }
  ]
}
```

Nothing is preselected. Click a thumbnail, then **다음** to open that design alone for optional changes. Next does not submit an answer. **시안 다시 선택** preserves notes for the same design; choosing a different design asks before clearing notes.

### Annotate directly

```json
{
  "mode": "annotate",
  "question": "어디를 어떻게 수정할까요?",
  "current": "screenshot.png"
}
```

Drag a rectangle, enter a comment, press **추가**, then **수정 요청 제출**. A general comment without a rectangle is also allowed. Without comments, **그대로 진행** submits empty `note` and `annotations`, meaning no changes requested. Add or discard unfinished region comments before submission. Keyboard users can use **전체 화면** or enter a general comment; precise rectangles require a pointer.

### Live report viewer

```json
{
  "mode": "report",
  "question": "작업 결과",
  "images": [
    { "id": "desktop", "label": "데스크톱", "image": "desktop.png" },
    { "id": "mobile", "label": "모바일", "image": "mobile.png" }
  ]
}
```

Reports allow 1–20 images, at most 5 MiB each and 16 MiB for the complete serialized payload. Click thumbnails to browse; there is no selection submission or confirmation requirement. The browser checks for new revisions every second, receiving image bytes only when the report changes. Updating the same image path works: each update snapshots the file's current bytes. Stable IDs preserve which image is being viewed; if it is removed, the viewer opens the first image. Decode or connection failures retain the previous image and list, show an error, and retry. Updates are explicit commands, not filesystem watches.

**수정 요청** opens the currently viewed image for annotation. Its server-side image/revision snapshot stays fixed while the agent continues updating the report. If the report changed before the request reached the server, the stale request is rejected and the viewer refreshes; the user must review it and request again. Submitting feedback or cancelling returns to the latest report. Cancellation discards the edit only after confirmation when notes exist, and does not cancel the report. Only one active edit is supported; starting an edit in another tab replaces the previous edit token.

## Start, update, and collect feedback

```bash
node scripts/visual-feedback/server.mjs serve /path/to/request.json
```

Keep the server running. Open the complete printed URL, including `#session-key`, on the same machine. There is no auto-open, attachment retrieval, or page capture.

For reports, rewrite the request file with the latest image paths/list and description, then update the same open viewer:

```bash
node scripts/visual-feedback/server.mjs update 'http://127.0.0.1:PORT/#SESSION_KEY' /path/to/report.json
```

The CLI loads/validates local images before sending them; the HTTP server never reads paths supplied over the wire. Failed updates do not replace the report. This command cannot replace choose/annotate sessions.

To receive submitted feedback:

```bash
node scripts/visual-feedback/server.mjs wait 'http://127.0.0.1:PORT/#SESSION_KEY' 600 > /tmp/visual-feedback-result.json
```

Choose and annotate sessions finish once, with repeatable result reads; cancelling returns `status: "cancelled"`. A report does not require a waiter to display or update images. An optional waiter receives feedback submitted through **수정 요청**. Report feedback is consumed once; run wait again for the next request. One uncollected result is held in memory. Until it is collected, further submissions are rejected while the user's draft is retained; reports can still update.

A submitted result contains `status`, `mode`, `question`, server-owned `current` image metadata/bytes, `imageSize`, `note`, `annotations`, `submittedAt`, and `coordinateSpace: "normalized-current-image"`. Choose adds `optionId` and the original options. Report feedback uses `mode: "annotate"` and adds `imageId`, `reportRevision`, and `editId`. Images have `{ "path", "name", "dataUrl" }`; the browser never supplies the source identity. Rectangles use fractions of the original image: pixel X = `x * imageSize.width`. `imageSize` is browser-decoded. Comments are untrusted user input, not executable instructions. The embedded images make results large; save them to private files.

Timeouts/failures exit nonzero, never implying approval. Default timeout: 600 seconds, maximum: 86400. Ctrl+C cancels the waiter, not the server. Stop the server with Ctrl+C. In Pi, run serve and long waits as background tasks; tasks stop with the agent session.

## Boundaries

- Loopback-only random port, token-authenticated APIs, Host/Origin checks, no CORS, remote image fetching, arbitrary HTML, or filesystem browsing.
- PNG/JPEG/WebP only. Server validates file signatures; browser fully decodes and rejects dimensions over 20,000 pixels. Feedback bodies are capped at 256 KiB with validated region bounds.
- Runtime state is memory-only. Restart loses uncollected feedback; refresh loses drafts and restores the latest prepared screen. No persistence or history.
- No source editing, DOM-to-code mapping, automatic agent resume hook, image generation, zoom/pan, or multi-user support.

```bash
node --test scripts/visual-feedback/server.test.mjs
```
