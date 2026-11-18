---
description: "MiniMax media tools: image generation, speech synthesis and recognition, music generation, and file upload on the same MiniMax API key as the model route."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-minimax-media

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-tool-minimax-media` adds the rest of the MiniMax capability surface to the agent: generate images, synthesize speech, transcribe audio, list and create voices, generate music, and upload files. Everything authenticates with the `MINIMAX_API_KEY` the model route uses. Artifacts MiniMax returns by URL are downloaded into the attachment store immediately, because those links expire within a day; an upload answers with the `mm_file://` reference the video tools accept.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin; the MiniMax key comes from the same reference the other MiniMax packages use.

| Tool | Endpoint | Result |
| --- | --- | --- |
| `minimax_image_generate` | `POST /v1/image_generation` | Stored PNGs plus their temporary source URLs |
| `minimax_speech_synthesize` | `POST /v1/t2a_v2` | Stored audio file |
| `minimax_speech_transcribe` | `POST /v1/speech_to_text` | Transcript text, duration, and speaker segments |
| `minimax_list_voices` | `POST /v1/get_voice` | Every voice this account may synthesize with |
| `minimax_voice_clone` | `POST /v1/voice_clone` | A cloned voice id and its preview recording |
| `minimax_voice_design` | `POST /v1/voice_design` | A designed voice id and its preview recording |
| `minimax_voice_delete` | `POST /v1/delete_voice` | The deleted voice id |
| `minimax_speech_synthesize_async` | `POST /v1/t2a_async_v2` | Stored audio file for a long text |
| `minimax_music_generate` | `POST /v1/music_generation` | Stored audio file |
| `minimax_music_cover` | `POST /v1/music_generation` | Stored audio file of a cover |
| `minimax_music_cover_preprocess` | `POST /v1/music_cover_preprocess` | The cover feature id and the extracted lyrics |
| `minimax_lyrics_generate` | `POST /v1/lyrics_generation` | The lyrics, their title, and their style tags |
| `minimax_file_upload` | `POST /v1/files/upload` | `file_id` and its `mm_file://` reference |
| `minimax_file_list` | `GET /v1/files/list` | The files stored for one purpose |
| `minimax_file_download` | `GET /v1/files/retrieve_content` | The stored file's bytes, kept in the workspace |
| `minimax_file_delete` | `POST /v1/files/delete` | The deleted file id |
| `minimax_count_tokens` | `POST /anthropic/v1/messages/count_tokens` | The input token count of a message |

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKeyEnv` | `MINIMAX_API_KEY` | Credential reference holding the key |
| `apiBaseURL` | `https://api.minimax.cn` | Native API root |
| `imageModel` / `aspectRatio` | `image-01` / `1:1` | Image defaults |
| `speechModel` / `voiceId` | `speech-2.8-hd` / `English_expressive_narrator` | Speech-synthesis defaults |
| `musicModel` | `music-3.0` | Music default |
| `asrModel` | `asr-1.0` | Recognition default |
| `audioFormat` / `sampleRate` | `mp3` / `32000` | Produced-audio defaults |
| `maxDownloadBytes` / `maxUploadBytes` | `134217728` / `52428800` | Download and upload caps |
| `pollIntervalMs` / `pollTimeoutMs` | `5000` / `600000` | Status cadence and deadline of a background task |

The two file-reading tools resolve the path through `ctx.fs`, so sandbox policy decides what they may upload.

<a id="understand-the-implementation"></a>
## Understand the implementation

Every native endpoint answers HTTP 200 and reports the real outcome in `base_resp.status_code`; the client turns a non-zero status into an error instead of returning an empty result. Image and audio responses carry a temporary URL, which is streamed through `attachments.saveFileStream` with a byte cap so the session keeps a durable file.

Speech recognition and file upload are multipart requests: the tool reads the file through the filesystem service, guesses the media type from the extension, and sends `model` plus `file` (and `purpose` for uploads) as form fields. `minimax_file_upload` returns `mm_file://{file_id}`, the reference `minimax_video_understand` accepts for a video too large to pass by URL.

Two endpoints answer in shapes the others do not. Recognition reads its language from a **request header**, so the client sends it there rather than in the body, and the subtitle forms answer with text instead of JSON, so the client reads them as text. Voice design answers with its preview **hex-encoded** rather than as a URL, so the client decodes those bytes and stores them directly.

The voice tools are two calls each where MiniMax requires two: cloning uploads the sample under the `voice_clone` purpose first, then posts `file_id` to the clone endpoint; designing posts the description and its preview text in one call and receives the new `voice_id`.

Three more shapes run through the same client. The asynchronous speech endpoint takes far more text than the synchronous one, so the tool creates a task, polls it, and then resolves the finished audio through the file endpoint. The cover workflow has two steps as well: preprocessing extracts the lyrics and the feature id, and the cover call turns those into a song. Token counting asks the Messages endpoint what a message would cost without generating anything, and it can measure at the admission tier the request will use.

The file content endpoint answers the raw bytes even though its spec declares `application/json`, so the client reads the body as bytes and never parses it.

All requests use `redirect: 'error'` so the key never follows a redirect to another origin.

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-tool-minimax-video`](../tool-minimax-video/README.md) — generation and understanding tools that share this credential.
- [`dsh-llm-minimax`](../../llm/llm-minimax/README.md) — the model route on the same key.
- [MiniMax image generation](https://platform.minimax.cn/docs/api-reference/image-generation-t2i), [speech synthesis](https://platform.minimax.cn/docs/api-reference/speech-t2a-http), [speech recognition](https://platform.minimax.cn/docs/api-reference/speech-to-text), [voice listing](https://platform.minimax.cn/docs/api-reference/voice-management-get), [voice cloning](https://platform.minimax.cn/docs/api-reference/voice-cloning-clone), [voice design](https://platform.minimax.cn/docs/api-reference/voice-design-design), [music](https://platform.minimax.cn/docs/api-reference/music-generation), and [file upload](https://platform.minimax.cn/docs/api-reference/file-management-upload) — the endpoints this package encodes.

<a id="model-experience"></a>
## Model Experience

### One media call

#### What the model sees

The model sees the tool schema, its arguments, and a result naming a stored path, a transcript, or a `mm_file://` reference. Produced images and audio never enter the conversation: the harness content model carries text, image, and file blocks, so a generated picture or song is a file the user opens. Transcription is the one capability whose output is conversation content, and it arrives as text.

#### Token effect

These calls spend no conversation tokens beyond the tool call and its result; MiniMax bills them per image, per character, or per audio second. The exception is a generated image later attached to a message: from then on its visual tokens count like any other image.

#### KV Cache effect

Each call is a separate MiniMax service with no relationship to the chat request, so nothing here can invalidate the session's prefix cache. A produced image that a later turn attaches changes that turn's prefix, exactly as any other new attachment would.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Produced media is not shown inline.** Results name stored paths; preview cards would need their own client slots, which this package does not add.
- **Uploads read workspace files only.** The filesystem service decides whether a path is reachable, and a deployment without `ctx.fs` gets an explanatory error.
- **Cloned voices expire.** MiniMax deletes a cloned voice that is never used within 7 days, and a cloned voice only appears in `minimax_list_voices` after it has been used once.
- Cloning needs a sample of 10 seconds to 5 minutes; a longer or shorter file is rejected by MiniMax, and the tool does not measure the duration itself.
- Voice design bills its preview separately, and the preview costs the same per character as synthesis.
- **The asynchronous speech tool takes text, not a file.** MiniMax also accepts a text file for a million characters, which this tool does not upload.
- The file endpoints name the purposes differently from the upload endpoint: the listing and deletion accept `t2a_async` and `video_generation`, which the upload endpoint does not.
- MiniMax retired the paid music and lyrics endpoints for new accounts on 2026-08-20; a key without music access answers those two tools with a permission error.

### Dev Note

Configuration is read at every call, so a changed voice, model, or endpoint applies to the next call without remounting the plugin. The tool bodies share one client module, which keeps envelope handling (`base_resp`) and download limits in one place.
