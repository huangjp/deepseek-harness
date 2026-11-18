/**
 * The MiniMax media client over a real local endpoint.
 *
 * Every native endpoint answers `200` and reports failure in `base_resp`, so the
 * envelope handling is pinned here; the multipart calls are checked for the
 * fields MiniMax requires (`model`, `purpose`, `response_format`).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  cloneVoice,
  countTokens,
  createAsyncSpeech,
  decodeHexAudio,
  deleteFile,
  deleteVoice,
  designVoice,
  downloadFileContent,
  downloadMedia,
  generateCover,
  generateImages,
  generateLyrics,
  generateMusic,
  listFiles,
  listVoices,
  preprocessCover,
  queryAsyncSpeech,
  retrieveFile,
  synthesizeSpeech,
  transcribe,
  uploadFile,
} from '../src/index.ts'
import type { MiniMaxMediaOptions } from '../src/index.ts'

/** One request the endpoint received. */
interface Received {
  readonly path: string
  readonly headers: IncomingMessage['headers']
  readonly raw: string
  readonly json: Record<string, unknown> | undefined
}

/** A local endpoint answering each path with one body. */
async function endpoint(
  answer: (received: Received) => { body: unknown; status?: number },
): Promise<{ api: string; received: Received[] }> {
  const received: Received[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('latin1')
      const isJson = (request.headers['content-type'] ?? '').includes('application/json')
      received.push({
        path: request.url ?? '',
        headers: request.headers,
        raw,
        json: isJson ? JSON.parse(raw) as Record<string, unknown> : undefined,
      })
      const reply = answer(received[received.length - 1] as Received)
      // Each fixture server closes with its test, so a pooled keep-alive socket
      // would be dead by the next call; closing the connection keeps the
      // client's pool from reusing it.
      response.writeHead(reply.status ?? 200, { 'content-type': 'application/json', connection: 'close' })
      response.end(JSON.stringify(reply.body))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  onTestFinished(async () => {
    const closed = once(server, 'close')
    server.closeAllConnections()
    server.close()
    await closed
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing endpoint address')
  return { api: `http://127.0.0.1:${String(address.port)}`, received }
}

/** Resolved options against one endpoint. */
function options(api: string): MiniMaxMediaOptions {
  return {
    apiBaseURL: api,
    apiKey: 'test-key',
    imageModel: 'image-01',
    speechModel: 'speech-2.8-hd',
    musicModel: 'music-3.0',
    asrModel: 'asr-1.0',
  }
}

describe('MiniMax media client', () => {
  it('generates images from a prompt and returns their URLs', async () => {
    const server = await endpoint(() => ({
      body: { data: { image_urls: ['https://cdn.test/a.png', 'https://cdn.test/b.png'] }, base_resp: { status_code: 0 } },
    }))

    const urls = await generateImages(options(server.api), { prompt: 'a red fox', aspectRatio: '16:9', count: 2, promptOptimizer: false })

    expect(urls).toEqual(['https://cdn.test/a.png', 'https://cdn.test/b.png'])
    expect(server.received[0]?.path).toBe('/v1/image_generation')
    expect(server.received[0]?.headers['authorization']).toBe('Bearer test-key')
    expect(server.received[0]?.json).toMatchObject({
      model: 'image-01',
      prompt: 'a red fox',
      aspect_ratio: '16:9',
      response_format: 'url',
      n: 2,
    })
  })

  it('turns an in-band failure status into an error', async () => {
    const server = await endpoint(() => ({ body: { data: null, base_resp: { status_code: 1026, status_msg: 'sensitive prompt' } } }))

    await expect(generateImages(options(server.api), { prompt: 'x', aspectRatio: '1:1', count: 1, promptOptimizer: false }))
      .rejects.toThrow(/status 1026: sensitive prompt/u)
  })

  it('refuses a successful envelope that carries no image', async () => {
    const server = await endpoint(() => ({ body: { data: { image_urls: [] }, base_resp: { status_code: 0 } } }))

    await expect(generateImages(options(server.api), { prompt: 'x', aspectRatio: '1:1', count: 1, promptOptimizer: false }))
      .rejects.toThrow(/no image URL/u)
  })

  it('synthesizes speech with the deployment voice and returns the audio URL', async () => {
    const server = await endpoint(() => ({ body: { data: { audio: 'https://cdn.test/v.mp3', status: 2 }, base_resp: { status_code: 0 } } }))

    const source = await synthesizeSpeech(options(server.api), {
      text: 'hello', voiceId: 'male-qn-qingse', format: 'mp3', sampleRate: 32_000,
    })

    expect(source).toBe('https://cdn.test/v.mp3')
    expect(server.received[0]?.path).toBe('/v1/t2a_v2')
    expect(server.received[0]?.json).toMatchObject({
      model: 'speech-2.8-hd',
      text: 'hello',
      stream: false,
      output_format: 'url',
      voice_setting: { voice_id: 'male-qn-qingse' },
      audio_setting: { format: 'mp3', sample_rate: 32_000 },
    })
  })

  it('generates music and forwards the instrumental choice', async () => {
    const server = await endpoint(() => ({ body: { data: { audio: 'https://cdn.test/song.mp3', status: 2 }, base_resp: { status_code: 0 } } }))

    const source = await generateMusic(options(server.api), {
      prompt: 'indie folk', instrumental: true, format: 'mp3', sampleRate: 44_100,
    })

    expect(source).toBe('https://cdn.test/song.mp3')
    expect(server.received[0]?.path).toBe('/v1/music_generation')
    expect(server.received[0]?.json).toMatchObject({ model: 'music-3.0', prompt: 'indie folk', is_instrumental: true })
  })

  it('transcribes an audio file as multipart form data', async () => {
    const server = await endpoint(() => ({ body: { text: 'hello world', duration: 3.5 } }))

    const result = await transcribe(options(server.api), {
      bytes: new Uint8Array([1, 2, 3]), name: 'clip.mp3', mediaType: 'audio/mpeg', responseFormat: 'json',
    })

    expect(result).toMatchObject({ text: 'hello world', duration: 3.5 })
    expect(server.received[0]?.path).toBe('/v1/speech_to_text')
    expect(server.received[0]?.headers['content-type']).toContain('multipart/form-data')
    expect(server.received[0]?.raw).toContain('name="model"')
    expect(server.received[0]?.raw).toContain('name="file"')
    expect(server.received[0]?.raw).toContain('asr-1.0')
  })

  it('sends the recognition language as the header MiniMax reads it from', async () => {
    const server = await endpoint(() => ({ body: { text: '你好' } }))

    await transcribe(options(server.api), {
      bytes: new Uint8Array([1, 2, 3]), name: 'clip.mp3', mediaType: 'audio/mpeg',
      responseFormat: 'json', language: 'zh',
    })

    expect(server.received[0]?.headers['language']).toBe('zh')
    expect(server.received[0]?.raw).toContain('name="response_format"')
  })

  it('returns the speaker segments of a verbose transcription', async () => {
    const server = await endpoint(() => ({
      body: {
        text: 'a b',
        duration: 2,
        n_speakers: 2,
        segments: [{ id: 1, start: 0, end: 1, speaker: 'S1', text: 'a' }],
      },
    }))

    const result = await transcribe(options(server.api), {
      bytes: new Uint8Array([1]), name: 'clip.mp3', mediaType: 'audio/mpeg',
      responseFormat: 'verbose_json', timestampLevel: 'word',
    })

    expect(result).toMatchObject({ n_speakers: 2, segments: [{ speaker: 'S1', text: 'a', start: 0, end: 1 }] })
    expect(server.received[0]?.raw).toContain('verbose_json')
    expect(server.received[0]?.raw).toContain('word')
  })

  it('reads a subtitle transcription as text rather than JSON', async () => {
    const server = await endpoint(() => ({ body: '1\n00:00:00,000 --> 00:00:01,000\nhello\n' }))

    const result = await transcribe(options(server.api), {
      bytes: new Uint8Array([1]), name: 'clip.mp3', mediaType: 'audio/mpeg', responseFormat: 'srt',
    })

    expect(result.text).toContain('00:00:00,000')
    expect(server.received[0]?.raw).toContain('name="response_format"')
  })

  it('lists the voices of every group the endpoint reports', async () => {
    const server = await endpoint(() => ({
      body: {
        system_voice: [{ voice_id: 'Chinese (Mandarin)_News_Anchor', voice_name: 'News Anchor', description: ['a voice'] }],
        voice_cloning: [{ voice_id: 'test12345', created_time: '2025-08-20' }],
        base_resp: { status_code: 0 },
      },
    }))

    const voices = await listVoices(options(server.api), { voiceType: 'all' })

    expect(server.received[0]?.path).toBe('/v1/get_voice')
    expect(server.received[0]?.json).toMatchObject({ voice_type: 'all' })
    expect(voices.map(entry => [entry.group, entry.voice.voice_id])).toEqual([
      ['system_voice', 'Chinese (Mandarin)_News_Anchor'],
      ['voice_cloning', 'test12345'],
    ])
  })

  it('clones a voice from an uploaded sample and reports its preview', async () => {
    const server = await endpoint(() => ({ body: { demo_audio: 'https://cdn.test/clone.mp3', base_resp: { status_code: 0 } } }))

    const cloned = await cloneVoice(options(server.api), {
      fileId: 42,
      voiceId: 'my_voice_01',
      text: 'hello there',
      model: 'speech-2.8-hd',
      needNoiseReduction: true,
    })

    expect(cloned).toEqual({ voiceId: 'my_voice_01', previewUrl: 'https://cdn.test/clone.mp3' })
    expect(server.received[0]?.path).toBe('/v1/voice_clone')
    expect(server.received[0]?.json).toMatchObject({
      file_id: 42,
      voice_id: 'my_voice_01',
      text: 'hello there',
      model: 'speech-2.8-hd',
      need_noise_reduction: true,
    })
  })

  it('designs a voice and decodes its hex preview', async () => {
    const server = await endpoint(() => ({
      body: { voice_id: 'ttv-voice-1', trial_audio: '000102ff', base_resp: { status_code: 0 } },
    }))

    const designed = await designVoice(options(server.api), { prompt: 'a deep narrator', previewText: 'once upon a time' })

    expect(designed.voiceId).toBe('ttv-voice-1')
    expect([...(designed.previewAudio ?? [])]).toEqual([0, 1, 2, 255])
    expect(server.received[0]?.path).toBe('/v1/voice_design')
    expect(server.received[0]?.json).toMatchObject({ prompt: 'a deep narrator', preview_text: 'once upon a time' })
  })

  it('refuses a malformed hex preview instead of storing garbage', () => {
    expect(() => decodeHexAudio('abc')).toThrow(/malformed hex/u)
    expect(() => decodeHexAudio('zz')).toThrow(/malformed hex/u)
  })

  it('forwards the voice settings the synthesis endpoint documents', async () => {
    const server = await endpoint(() => ({ body: { data: { audio: 'https://cdn.test/v.mp3' }, base_resp: { status_code: 0 } } }))

    await synthesizeSpeech(options(server.api), {
      text: 'hi', voiceId: 'v1', format: 'mp3', sampleRate: 32_000,
      emotion: 'calm', speed: 1.2, volume: 2, pitch: -3, languageBoost: 'Chinese', channel: 2, bitrate: 128_000,
    })

    expect(server.received[0]?.json).toMatchObject({
      voice_setting: { voice_id: 'v1', emotion: 'calm', speed: 1.2, vol: 2, pitch: -3 },
      audio_setting: { format: 'mp3', sample_rate: 32_000, channel: 2, bitrate: 128_000 },
      language_boost: 'Chinese',
    })
  })

  it('forwards the image prompt optimizer and seed', async () => {
    const server = await endpoint(() => ({ body: { data: { image_urls: ['https://cdn.test/a.png'] } } }))

    await generateImages(options(server.api), {
      prompt: 'a fox', aspectRatio: '1:1', count: 1, promptOptimizer: true, seed: 42,
    })

    expect(server.received[0]?.json).toMatchObject({ prompt_optimizer: true, seed: 42 })
  })

  it('uploads a file and returns its reference id', async () => {
    const server = await endpoint(() => ({ body: { file: { file_id: 123, bytes: 3 }, base_resp: { status_code: 0 } } }))

    const fileId = await uploadFile(options(server.api), {
      bytes: new Uint8Array([1, 2, 3]), name: 'clip.mp4', mediaType: 'video/mp4', purpose: 'video_understanding',
    })

    expect(fileId).toBe(123)
    expect(server.received[0]?.path).toBe('/v1/files/upload')
    expect(server.received[0]?.raw).toContain('video_understanding')
  })

  it('bounds downloads by bytes', async () => {
    const payload = new Uint8Array(32).fill(9)
    const server = createServer((_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(payload)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    onTestFinished(async () => {
      const closed = once(server, 'close')
      server.closeAllConnections()
      server.close()
      await closed
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing download address')
    const source = `http://127.0.0.1:${String(address.port)}/f.bin`

    const chunks: Uint8Array[] = []
    for await (const chunk of downloadMedia(source, 64)) chunks.push(chunk)
    expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).byteLength).toBe(32)

    await expect(async () => {
      for await (const _chunk of downloadMedia(source, 4)) { /* consume */ }
    }).rejects.toThrow(/download limit/u)
  })

  it('deletes a voice through the endpoint that takes it in the body', async () => {
    const server = await endpoint(() => ({ body: { voice_id: 'my_voice_01', base_resp: { status_code: 0 } } }))

    const voiceId = await deleteVoice(options(server.api), { voiceType: 'voice_cloning', voiceId: 'my_voice_01' })

    expect(voiceId).toBe('my_voice_01')
    expect(server.received[0]?.path).toBe('/v1/delete_voice')
    expect(server.received[0]?.json).toMatchObject({ voice_type: 'voice_cloning', voice_id: 'my_voice_01' })
  })

  it('creates an asynchronous speech task and reads its state', async () => {
    const server = await endpoint(() => ({
      body: { task_id: '95157322514444', file_id: 95157322514496, base_resp: { status_code: 0 } },
    }))

    const created = await createAsyncSpeech(options(server.api), {
      text: 'a long text', voiceId: 'v1', format: 'mp3', sampleRate: 32_000, emotion: 'calm',
    })

    expect(created).toEqual({ taskId: '95157322514444', fileId: 95157322514496 })
    expect(server.received[0]?.path).toBe('/v1/t2a_async_v2')
    expect(server.received[0]?.json).toMatchObject({
      model: 'speech-2.8-hd',
      text: 'a long text',
      voice_setting: { voice_id: 'v1', emotion: 'calm' },
      audio_setting: { format: 'mp3', audio_sample_rate: 32_000 },
    })
  })

  it('reads an asynchronous speech task through the query endpoint', async () => {
    const server = await endpoint(() => ({ body: { task_id: 95157322514444, status: 'Processing' } }))

    const polled = await queryAsyncSpeech(options(server.api), '95157322514444')

    expect(polled.status).toBe('processing')
    expect(server.received[0]?.path).toBe('/v1/query/t2a_async_query_v2?task_id=95157322514444')
  })

  it('preprocesses a reference song into a cover feature', async () => {
    const server = await endpoint(() => ({
      body: {
        cover_feature_id: 'a1b2c3',
        formatted_lyrics: '[Verse 1]\n...',
        structure_result: '{"num_segments":4}',
        audio_duration: 90,
        base_resp: { status_code: 0 },
      },
    }))

    const preprocessed = await preprocessCover(options(server.api), { audioUrl: 'https://cdn.test/song.mp3' })

    expect(preprocessed.coverFeatureId).toBe('a1b2c3')
    expect(preprocessed.audioDuration).toBe(90)
    expect(server.received[0]?.path).toBe('/v1/music_cover_preprocess')
    expect(server.received[0]?.json).toMatchObject({ model: 'music-cover', audio_url: 'https://cdn.test/song.mp3' })
  })

  it('generates a cover from a feature id and its lyrics', async () => {
    const server = await endpoint(() => ({ body: { data: { audio: 'https://cdn.test/cover.mp3' }, base_resp: { status_code: 0 } } }))

    const source = await generateCover(options(server.api), {
      prompt: 'a warm acoustic take', coverFeatureId: 'a1b2c3', lyrics: '[Verse 1]\n...', format: 'mp3',
    })

    expect(source).toBe('https://cdn.test/cover.mp3')
    expect(server.received[0]?.path).toBe('/v1/music_generation')
    expect(server.received[0]?.json).toMatchObject({
      model: 'music-cover',
      prompt: 'a warm acoustic take',
      cover_feature_id: 'a1b2c3',
      lyrics: '[Verse 1]\n...',
    })
  })

  it('writes lyrics and reports the title and style tags', async () => {
    const server = await endpoint(() => ({
      body: {
        song_title: 'Summer Breeze Promise',
        style_tags: 'Pop, Summer Vibe',
        lyrics: '[Intro]\n...',
        base_resp: { status_code: 0 },
      },
    }))

    const written = await generateLyrics(options(server.api), { mode: 'write_full_song', prompt: 'a summer song' })

    expect(written).toMatchObject({ songTitle: 'Summer Breeze Promise', styleTags: 'Pop, Summer Vibe' })
    expect(server.received[0]?.path).toBe('/v1/lyrics_generation')
    expect(server.received[0]?.json).toMatchObject({ mode: 'write_full_song', prompt: 'a summer song' })
  })

  it('lists the stored files of one purpose', async () => {
    const server = await endpoint(() => ({
      body: { files: [{ file_id: 123, filename: 'clip.mp4', purpose: 'video_generation_input' }] },
    }))

    const files = await listFiles(options(server.api), { purpose: 'video_generation_input' })

    expect(files[0]?.file_id).toBe(123)
    expect(server.received[0]?.path).toBe('/v1/files/list?purpose=video_generation_input')
  })

  it('reads a stored file and its download URL', async () => {
    const server = await endpoint(() => ({
      body: { file: { file_id: 123, filename: 'out.mp4', download_url: 'https://cdn.test/out.mp4' } },
    }))

    const file = await retrieveFile(options(server.api), 123)

    expect(file?.download_url).toBe('https://cdn.test/out.mp4')
    expect(server.received[0]?.path).toBe('/v1/files/retrieve?file_id=123')
  })

  it('deletes a stored file with its id and purpose', async () => {
    const server = await endpoint(() => ({ body: { file_id: 123, base_resp: { status_code: 0 } } }))

    const fileId = await deleteFile(options(server.api), { fileId: 123, purpose: 't2a_async_input' })

    expect(fileId).toBe(123)
    expect(server.received[0]?.path).toBe('/v1/files/delete')
    expect(server.received[0]?.json).toMatchObject({ file_id: 123, purpose: 't2a_async_input' })
  })

  it('counts the input tokens of a message', async () => {
    const server = await endpoint(() => ({ body: { usage: { input_tokens: 3, cache_read_input_tokens: 0 } } }))

    const counted = await countTokens(options(server.api), {
      model: 'MiniMax-M3.1-Flash',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    expect(counted.inputTokens).toBe(3)
    expect(server.received[0]?.path).toBe('/anthropic/v1/messages/count_tokens')
    expect(server.received[0]?.json).toMatchObject({
      model: 'MiniMax-M3.1-Flash',
      messages: [{ role: 'user', content: 'Hello' }],
    })
  })

  it('measures the tokens at the admission tier the request will use', async () => {
    const server = await endpoint(() => ({ body: { usage: { input_tokens: 7 } } }))

    await countTokens(options(server.api), {
      model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'Hello' }],
      serviceTier: 'priority',
    })

    expect(server.received[0]?.json).toMatchObject({ service_tier: 'priority' })
  })

  it('streams a stored file as bytes rather than parsing it as JSON', async () => {
    const payload = new Uint8Array([1, 2, 3, 4])
    const server = createServer((_request: IncomingMessage, response: ServerResponse) => {
      // MiniMax answers the raw bytes even though its spec declares JSON.
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(payload)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    onTestFinished(async () => {
      const closed = once(server, 'close')
      server.closeAllConnections()
      server.close()
      await closed
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing endpoint address')

    const chunks: number[] = []
    for await (const chunk of downloadFileContent(options(`http://127.0.0.1:${String(address.port)}`), 123, 64)) {
      chunks.push(...chunk)
    }

    expect(chunks).toEqual([1, 2, 3, 4])
  })
})
