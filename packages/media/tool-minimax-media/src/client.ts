/**
 * The MiniMax media API calls behind the image, speech, voice, music, and file
 * tools.
 *
 * Every native MiniMax endpoint answers HTTP 200 and reports the real outcome in
 * `base_resp.status_code`, so a successful transport is not a successful call;
 * {@link unwrap} is what turns that envelope into an error. Audio and image
 * production return a URL (24-hour lifetime), which the tools download into the
 * attachment store immediately. Voice design is the exception: it returns its
 * preview hex-encoded, so the tool decodes those bytes instead.
 *
 * @module @deepseek-ai/dsh-tool-minimax-media/client
 */
import type {
  MiniMaxAsyncSpeechResponse,
  MiniMaxAsyncSpeechStatusResponse,
  MiniMaxAudioResponse,
  MiniMaxCoverPreprocessResponse,
  MiniMaxCountTokensResponse,
  MiniMaxFileDeleteResponse,
  MiniMaxFileEntry,
  MiniMaxFileListResponse,
  MiniMaxFileRetrieveResponse,
  MiniMaxFileUploadResponse,
  MiniMaxImageResponse,
  MiniMaxLyricsResponse,
  MiniMaxTranscription,
  MiniMaxVoiceCloneResponse,
  MiniMaxVoiceDeleteResponse,
  MiniMaxVoiceDesignResponse,
  MiniMaxVoiceEntry,
  MiniMaxVoiceGroup,
  MiniMaxVoiceListResponse,
} from './types.ts'

/** Attribution sent with every request. */
const USER_AGENT = 'deepseek-harness-tool-minimax-media'

/** Endpoints and defaults one call uses. */
export interface MiniMaxMediaOptions {
  /** Native API root, for example `https://api.minimax.cn`. */
  apiBaseURL: string
  /** API key for this call. */
  apiKey: string
  /** Image model. */
  imageModel: string
  /** Speech-synthesis model. */
  speechModel: string
  /** Music model. */
  musicModel: string
  /** Speech-recognition model. */
  asrModel: string
}

/** Throw the caller's abort reason, or a stable cancellation error. */
function abortError(signal: AbortSignal | undefined): Error {
  if (signal?.aborted === true && signal.reason instanceof Error) return signal.reason
  return new Error('MiniMax media operation aborted')
}

/** Join a root and a path without doubling separators. */
function url(root: string, path: string): string {
  return `${root.replace(/\/+$/u, '')}${path}`
}

/** Reject a `base_resp` that reports failure. */
function unwrap<T extends { base_resp?: { status_code?: number; status_msg?: string } | null }>(body: T, what: string): T {
  const status = body.base_resp?.status_code
  if (status !== undefined && status !== 0) {
    throw new Error(`${what} failed with status ${String(status)}${body.base_resp?.status_msg === undefined ? '' : `: ${body.base_resp.status_msg}`}`)
  }
  return body
}

/** Copy bytes into an exactly sized buffer, which is the Blob part type fetch accepts. */
function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

/**
 * Decode the hex-encoded audio a voice-design call returns.
 * @param hex - the hex payload.
 * @returns the audio bytes.
 * @throws when the payload is not an even-length hex string.
 */
export function decodeHexAudio(hex: string): Uint8Array {
  const clean = hex.trim()
  if (clean.length === 0) throw new Error('MiniMax returned no preview audio')
  if (clean.length % 2 !== 0) throw new Error('MiniMax returned a malformed hex audio payload')
  const bytes = new Uint8Array(clean.length / 2)
  for (let index = 0; index < bytes.length; index++) {
    const byte = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new Error('MiniMax returned a malformed hex audio payload')
    bytes[index] = byte
  }
  return bytes
}

/** Send one JSON request and decode the body. */
async function sendJson<T>(
  endpoint: string,
  options: MiniMaxMediaOptions,
  init: { method?: 'GET' | 'POST'; body?: unknown; headers?: Record<string, string> },
  signal: AbortSignal | undefined,
  what: string,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: init.method ?? 'POST',
      // Credentials never follow a redirect to another origin.
      redirect: 'error',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        accept: 'application/json',
        'user-agent': USER_AGENT,
        ...init.body === undefined ? {} : { 'content-type': 'application/json' },
        ...init.headers ?? {},
      },
      ...init.body === undefined ? {} : { body: JSON.stringify(init.body) },
      ...signal === undefined ? {} : { signal },
    })
  } catch (error: unknown) {
    if (signal?.aborted === true) throw abortError(signal)
    throw new Error(`${what} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`${what} answered HTTP ${String(response.status)}${detail.length === 0 ? '' : `: ${detail.slice(0, 400)}`}`)
  }
  try {
    return await response.json() as T
  } catch (error: unknown) {
    throw new Error(`${what} returned unreadable JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Send one multipart request (file uploads and speech recognition).
 * @param endpoint - the endpoint to call.
 * @param options - endpoint defaults and credential.
 * @param form - the multipart body.
 * @param what - the operation's name, for diagnostics.
 * @param signal - caller cancellation.
 * @param headers - extra request headers.
 * @param asText - read the body as text instead of JSON, which the subtitle
 *   formats of speech recognition need.
 * @returns the decoded body.
 */
async function multipart<T>(
  endpoint: string,
  options: MiniMaxMediaOptions,
  form: FormData,
  what: string,
  signal: AbortSignal | undefined,
  headers: Record<string, string> = {},
  asText = false,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${options.apiKey}`, 'user-agent': USER_AGENT, ...headers },
      body: form,
      ...signal === undefined ? {} : { signal },
    })
  } catch (error: unknown) {
    if (signal?.aborted === true) throw abortError(signal)
    throw new Error(`${what} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`${what} answered HTTP ${String(response.status)}${detail.length === 0 ? '' : `: ${detail.slice(0, 400)}`}`)
  }
  if (asText) return await response.text() as T
  try {
    return await response.json() as T
  } catch (error: unknown) {
    throw new Error(`${what} returned unreadable JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** One image-generation request. */
export interface ImageRequest {
  prompt: string
  aspectRatio: string
  count: number
  /** Let MiniMax rewrite the prompt before generating. */
  promptOptimizer: boolean
  /** Seed for a reproducible result; random when absent. */
  seed?: number
  /** Public reference image for image-to-image. */
  subjectReferenceUrl?: string
}

/**
 * Generate images and return their temporary URLs.
 * @param options - endpoint, model, and credential.
 * @param request - prompt, aspect ratio, count, and optimization switches.
 * @param signal - caller cancellation.
 * @returns the image URLs MiniMax produced.
 */
export async function generateImages(
  options: MiniMaxMediaOptions,
  request: ImageRequest,
  signal?: AbortSignal,
): Promise<string[]> {
  const body = await sendJson<MiniMaxImageResponse>(
    url(options.apiBaseURL, '/v1/image_generation'),
    options,
    {
      body: {
        model: options.imageModel,
        prompt: request.prompt,
        aspect_ratio: request.aspectRatio,
        response_format: 'url',
        n: request.count,
        prompt_optimizer: request.promptOptimizer,
        ...request.seed === undefined ? {} : { seed: request.seed },
        ...request.subjectReferenceUrl === undefined
          ? {}
          : { subject_reference: [{ type: 'character', image_file: request.subjectReferenceUrl }] },
      },
    },
    signal,
    'MiniMax image generation',
  )
  const urls = unwrap(body, 'MiniMax image generation').data?.image_urls ?? []
  if (urls.length === 0) throw new Error('MiniMax image generation returned no image URL')
  return urls
}

/**
 * Synthesize speech and return the audio URL.
 * @param options - endpoint, model, and credential.
 * @param request - text, voice, voice settings, and audio format.
 * @param signal - caller cancellation.
 * @returns the temporary audio URL.
 */
export async function synthesizeSpeech(
  options: MiniMaxMediaOptions,
  request: {
    text: string
    voiceId: string
    format: string
    sampleRate: number
    speed?: number
    volume?: number
    pitch?: number
    emotion?: string
    languageBoost?: string
    channel?: number
    bitrate?: number
  },
  signal?: AbortSignal,
): Promise<string> {
  const body = await sendJson<MiniMaxAudioResponse>(
    url(options.apiBaseURL, '/v1/t2a_v2'),
    options,
    {
      body: {
        model: options.speechModel,
        text: request.text,
        stream: false,
        output_format: 'url',
        voice_setting: {
          voice_id: request.voiceId,
          ...request.speed === undefined ? {} : { speed: request.speed },
          ...request.volume === undefined ? {} : { vol: request.volume },
          ...request.pitch === undefined ? {} : { pitch: request.pitch },
          ...request.emotion === undefined ? {} : { emotion: request.emotion },
        },
        audio_setting: {
          format: request.format,
          sample_rate: request.sampleRate,
          ...request.channel === undefined ? {} : { channel: request.channel },
          ...request.bitrate === undefined ? {} : { bitrate: request.bitrate },
        },
        ...request.languageBoost === undefined ? {} : { language_boost: request.languageBoost },
      },
    },
    signal,
    'MiniMax speech synthesis',
  )
  const audio = unwrap(body, 'MiniMax speech synthesis').data?.audio
  if (audio === undefined || audio === null || audio.length === 0) throw new Error('MiniMax speech synthesis returned no audio')
  return audio
}

/**
 * Generate music and return the audio URL.
 * @param options - endpoint, model, and credential.
 * @param request - prompt, optional lyrics, and format.
 * @param signal - caller cancellation.
 * @returns the temporary audio URL.
 */
export async function generateMusic(
  options: MiniMaxMediaOptions,
  request: { prompt: string; lyrics?: string; instrumental: boolean; format: string; sampleRate: number },
  signal?: AbortSignal,
): Promise<string> {
  const body = await sendJson<MiniMaxAudioResponse>(
    url(options.apiBaseURL, '/v1/music_generation'),
    options,
    {
      body: {
        model: options.musicModel,
        prompt: request.prompt,
        output_format: 'url',
        is_instrumental: request.instrumental,
        audio_setting: { format: request.format, sample_rate: request.sampleRate },
        ...request.lyrics === undefined ? {} : { lyrics: request.lyrics },
      },
    },
    signal,
    'MiniMax music generation',
  )
  const audio = unwrap(body, 'MiniMax music generation').data?.audio
  if (audio === undefined || audio === null || audio.length === 0) throw new Error('MiniMax music generation returned no audio')
  return audio
}

/**
 * Transcribe one audio file.
 *
 * The language is a request header rather than a body field, and the subtitle
 * formats answer with text rather than JSON, so both are handled here.
 * @param options - endpoint, model, and credential.
 * @param request - file bytes, display name, MIME type, and response format.
 * @param signal - caller cancellation.
 * @returns the transcript, its duration, and its speaker segments when the
 *   verbose form was asked for.
 */
export async function transcribe(
  options: MiniMaxMediaOptions,
  request: {
    bytes: Uint8Array
    name: string
    mediaType: string
    language?: string
    responseFormat: 'json' | 'verbose_json' | 'srt' | 'vtt'
    timestampLevel?: 'sentence' | 'word'
  },
  signal?: AbortSignal,
): Promise<MiniMaxTranscription> {
  const form = new FormData()
  form.set('model', options.asrModel)
  form.set('response_format', request.responseFormat)
  if (request.timestampLevel !== undefined) form.set('timestamp_level', request.timestampLevel)
  form.set('file', new Blob([exactBuffer(request.bytes)], { type: request.mediaType }), request.name)
  const headers = request.language === undefined ? {} : { language: request.language }
  if (request.responseFormat === 'json' || request.responseFormat === 'verbose_json') {
    return unwrap(
      await multipart<MiniMaxTranscription>(
        url(options.apiBaseURL, '/v1/speech_to_text'), options, form, 'MiniMax transcription', signal, headers,
      ),
      'MiniMax transcription',
    )
  }
  const subtitle = await multipart<string>(
    url(options.apiBaseURL, '/v1/speech_to_text'), options, form, 'MiniMax transcription', signal, headers, true,
  )
  return { text: subtitle }
}

/**
 * List the voices this account may synthesize with.
 * @param options - endpoint and credential.
 * @param request - which voice groups to read.
 * @param signal - caller cancellation.
 * @returns every voice, tagged with the group it came from.
 */
export async function listVoices(
  options: MiniMaxMediaOptions,
  request: { voiceType: 'system' | 'voice_cloning' | 'voice_generation' | 'all' },
  signal?: AbortSignal,
): Promise<{ voice: MiniMaxVoiceEntry; group: MiniMaxVoiceGroup }[]> {
  const body = unwrap(
    await sendJson<MiniMaxVoiceListResponse>(
      url(options.apiBaseURL, '/v1/get_voice'),
      options,
      { body: { voice_type: request.voiceType } },
      signal,
      'MiniMax voice listing',
    ),
    'MiniMax voice listing',
  )
  const groups: { group: MiniMaxVoiceGroup; entries: MiniMaxVoiceEntry[] | undefined }[] = [
    { group: 'system_voice', entries: body.system_voice },
    { group: 'voice_cloning', entries: body.voice_cloning },
    { group: 'voice_generation', entries: body.voice_generation },
  ]
  return groups.flatMap(({ group, entries }) =>
    (entries ?? []).map(voice => ({ voice, group })))
}

/**
 * Clone a voice from an uploaded sample.
 * @param options - endpoint, model, and credential.
 * @param request - the sample file id, the new voice id, and the preview and
 *   similarity switches.
 * @param signal - caller cancellation.
 * @returns the cloned voice id and its preview audio URL when one was asked for.
 */
export async function cloneVoice(
  options: MiniMaxMediaOptions,
  request: {
    fileId: number
    voiceId: string
    text?: string
    model?: string
    languageBoost?: string
    textValidation?: string
    accuracy?: number
    needNoiseReduction?: boolean
    needVolumeNormalization?: boolean
    clonePrompt?: { promptAudio: number; promptText: string }
  },
  signal?: AbortSignal,
): Promise<{ voiceId: string; previewUrl?: string }> {
  const body = unwrap(
    await sendJson<MiniMaxVoiceCloneResponse>(
      url(options.apiBaseURL, '/v1/voice_clone'),
      options,
      {
        body: {
          file_id: request.fileId,
          voice_id: request.voiceId,
          ...request.clonePrompt === undefined
            ? {}
            : {
              clone_prompt: {
                prompt_audio: request.clonePrompt.promptAudio,
                prompt_text: request.clonePrompt.promptText,
              },
            },
          ...request.text === undefined ? {} : { text: request.text },
          ...request.model === undefined ? {} : { model: request.model },
          ...request.languageBoost === undefined ? {} : { language_boost: request.languageBoost },
          ...request.textValidation === undefined ? {} : { text_validation: request.textValidation },
          ...request.accuracy === undefined ? {} : { accuracy: request.accuracy },
          ...request.needNoiseReduction === undefined ? {} : { need_noise_reduction: request.needNoiseReduction },
          ...request.needVolumeNormalization === undefined ? {} : { need_volume_normalization: request.needVolumeNormalization },
        },
      },
      signal,
      'MiniMax voice cloning',
    ),
    'MiniMax voice cloning',
  )
  const previewUrl = body.demo_audio
  return {
    voiceId: request.voiceId,
    ...previewUrl === undefined || previewUrl.length === 0 ? {} : { previewUrl },
  }
}

/**
 * Design a voice from a description.
 * @param options - endpoint and credential.
 * @param request - the voice description and its preview text.
 * @param signal - caller cancellation.
 * @returns the generated voice id and its hex-encoded preview audio.
 */
export async function designVoice(
  options: MiniMaxMediaOptions,
  request: { prompt: string; previewText: string; voiceId?: string },
  signal?: AbortSignal,
): Promise<{ voiceId: string; previewAudio?: Uint8Array }> {
  const body = unwrap(
    await sendJson<MiniMaxVoiceDesignResponse>(
      url(options.apiBaseURL, '/v1/voice_design'),
      options,
      {
        body: {
          prompt: request.prompt,
          preview_text: request.previewText,
          ...request.voiceId === undefined ? {} : { voice_id: request.voiceId },
        },
      },
      signal,
      'MiniMax voice design',
    ),
    'MiniMax voice design',
  )
  if (body.voice_id === undefined || body.voice_id.length === 0) {
    throw new Error('MiniMax voice design returned no voice_id')
  }
  const previewAudio = body.trial_audio === undefined || body.trial_audio.length === 0
    ? undefined
    : decodeHexAudio(body.trial_audio)
  return {
    voiceId: body.voice_id,
    ...previewAudio === undefined ? {} : { previewAudio },
  }
}

/**
 * Delete a cloned or designed voice.
 * @param options - endpoint and credential.
 * @param request - the voice group and the voice id.
 * @param signal - caller cancellation.
 * @returns the id of the deleted voice.
 */
export async function deleteVoice(
  options: MiniMaxMediaOptions,
  request: { voiceType: 'voice_cloning' | 'voice_generation'; voiceId: string },
  signal?: AbortSignal,
): Promise<string> {
  const body = unwrap(
    await sendJson<MiniMaxVoiceDeleteResponse>(
      url(options.apiBaseURL, '/v1/delete_voice'),
      options,
      { body: { voice_type: request.voiceType, voice_id: request.voiceId } },
      signal,
      'MiniMax voice deletion',
    ),
    'MiniMax voice deletion',
  )
  return body.voice_id ?? request.voiceId
}

/**
 * Create an asynchronous speech-synthesis task, which takes far more text than
 * the synchronous endpoint does.
 * @param options - endpoint, model, and credential.
 * @param request - the text, the voice settings, and the audio format.
 * @param signal - caller cancellation.
 * @returns the task id and, when MiniMax already knows it, the audio file id.
 */
export async function createAsyncSpeech(
  options: MiniMaxMediaOptions,
  request: {
    text: string
    voiceId: string
    format: string
    sampleRate: number
    speed?: number
    volume?: number
    pitch?: number
    emotion?: string
    languageBoost?: string
  },
  signal?: AbortSignal,
): Promise<{ taskId: string; fileId?: number }> {
  const body = unwrap(
    await sendJson<MiniMaxAsyncSpeechResponse>(
      url(options.apiBaseURL, '/v1/t2a_async_v2'),
      options,
      {
        body: {
          model: options.speechModel,
          text: request.text,
          voice_setting: {
            voice_id: request.voiceId,
            ...request.speed === undefined ? {} : { speed: request.speed },
            ...request.volume === undefined ? {} : { vol: request.volume },
            ...request.pitch === undefined ? {} : { pitch: request.pitch },
            ...request.emotion === undefined ? {} : { emotion: request.emotion },
          },
          audio_setting: { format: request.format, audio_sample_rate: request.sampleRate },
          ...request.languageBoost === undefined ? {} : { language_boost: request.languageBoost },
        },
      },
      signal,
      'MiniMax asynchronous speech synthesis',
    ),
    'MiniMax asynchronous speech synthesis',
  )
  if (body.task_id === undefined || body.task_id.length === 0) {
    throw new Error('MiniMax asynchronous speech synthesis returned no task_id')
  }
  return {
    taskId: body.task_id,
    ...body.file_id === undefined ? {} : { fileId: body.file_id },
  }
}

/**
 * Read one asynchronous speech task's state.
 * @param options - endpoint and credential.
 * @param taskId - the task to read.
 * @param signal - caller cancellation.
 * @returns the task status and, once it finished, the audio file id.
 */
export async function queryAsyncSpeech(
  options: MiniMaxMediaOptions,
  taskId: string,
  signal?: AbortSignal,
): Promise<{ status: string; fileId?: number }> {
  const body = unwrap(
    await sendJson<MiniMaxAsyncSpeechStatusResponse>(
      url(options.apiBaseURL, `/v1/query/t2a_async_query_v2?task_id=${encodeURIComponent(taskId)}`),
      options,
      { method: 'GET' },
      signal,
      'MiniMax asynchronous speech query',
    ),
    'MiniMax asynchronous speech query',
  )
  return {
    status: (body.status ?? 'unknown').toLowerCase(),
    ...body.file_id === undefined ? {} : { fileId: body.file_id },
  }
}

/**
 * List the stored files of one purpose.
 * @param options - endpoint and credential.
 * @param request - the purpose to read.
 * @param signal - caller cancellation.
 * @returns the files MiniMax holds for that purpose.
 */
export async function listFiles(
  options: MiniMaxMediaOptions,
  request: { purpose: string },
  signal?: AbortSignal,
): Promise<MiniMaxFileEntry[]> {
  const body = unwrap(
    await sendJson<MiniMaxFileListResponse>(
      url(options.apiBaseURL, `/v1/files/list?purpose=${encodeURIComponent(request.purpose)}`),
      options,
      { method: 'GET' },
      signal,
      'MiniMax file listing',
    ),
    'MiniMax file listing',
  )
  return body.files ?? []
}

/**
 * Read one stored file's metadata and its time-limited download URL.
 * @param options - endpoint and credential.
 * @param fileId - the file to read.
 * @param signal - caller cancellation.
 * @returns the file's metadata, including its download URL.
 */
export async function retrieveFile(
  options: MiniMaxMediaOptions,
  fileId: number,
  signal?: AbortSignal,
): Promise<MiniMaxFileEntry | undefined> {
  const body = unwrap(
    await sendJson<MiniMaxFileRetrieveResponse>(
      url(options.apiBaseURL, `/v1/files/retrieve?file_id=${String(fileId)}`),
      options,
      { method: 'GET' },
      signal,
      'MiniMax file retrieval',
    ),
    'MiniMax file retrieval',
  )
  return body.file ?? undefined
}

/**
 * Delete one stored file.
 * @param options - endpoint and credential.
 * @param request - the file id and the purpose it was stored under.
 * @param signal - caller cancellation.
 * @returns the id of the deleted file.
 */
export async function deleteFile(
  options: MiniMaxMediaOptions,
  request: { fileId: number; purpose: string },
  signal?: AbortSignal,
): Promise<number> {
  const body = unwrap(
    await sendJson<MiniMaxFileDeleteResponse>(
      url(options.apiBaseURL, '/v1/files/delete'),
      options,
      { body: { file_id: request.fileId, purpose: request.purpose } },
      signal,
      'MiniMax file deletion',
    ),
    'MiniMax file deletion',
  )
  return body.file_id ?? request.fileId
}

/**
 * Stream a stored file's bytes.
 *
 * MiniMax's content endpoint answers the raw bytes even though its spec
 * declares `application/json`, so the body is read as bytes and never parsed.
 * @param options - endpoint and credential.
 * @param fileId - the file to read.
 * @param maxBytes - largest accepted body.
 * @param signal - caller cancellation.
 * @returns the file's bytes in order.
 */
export async function* downloadFileContent(
  options: MiniMaxMediaOptions,
  fileId: number,
  maxBytes: number,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  const endpoint = url(options.apiBaseURL, `/v1/files/retrieve_content?file_id=${String(fileId)}`)
  let response: Response
  try {
    response = await fetch(endpoint, {
      redirect: 'error',
      headers: { authorization: `Bearer ${options.apiKey}`, 'user-agent': USER_AGENT },
      ...signal === undefined ? {} : { signal },
    })
  } catch (error: unknown) {
    if (signal?.aborted === true) throw abortError(signal)
    throw new Error(`MiniMax file download failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `MiniMax file download answered HTTP ${String(response.status)}${detail.length === 0 ? '' : `: ${detail.slice(0, 400)}`}`,
    )
  }
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new Error(`MiniMax file exceeds the ${String(maxBytes)}-byte download limit`)
    yield bytes
    return
  }
  let total = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new Error(`MiniMax file exceeds the ${String(maxBytes)}-byte download limit`)
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Count the input tokens a request would cost.
 * @param options - endpoint, model, and credential.
 * @param request - the model and the messages to measure.
 * @param signal - caller cancellation.
 * @returns the token counts MiniMax reported.
 */
export async function countTokens(
  options: MiniMaxMediaOptions,
  request: {
    model: string
    messages: { role: 'user'; content: string }[]
    /** Admission tier the measurement should match. */
    serviceTier?: 'standard' | 'priority'
  },
  signal?: AbortSignal,
): Promise<{ inputTokens: number; cacheReadTokens?: number }> {
  const body = await sendJson<MiniMaxCountTokensResponse>(
    url(options.apiBaseURL, '/anthropic/v1/messages/count_tokens'),
    options,
    {
      body: {
        model: request.model,
        messages: request.messages,
        ...request.serviceTier === undefined ? {} : { service_tier: request.serviceTier },
      },
    },
    signal,
    'MiniMax token counting',
  )
  const usage = body.usage
  if (usage?.input_tokens === undefined) {
    throw new Error('MiniMax token counting returned no input token count')
  }
  return {
    inputTokens: usage.input_tokens,
    ...usage.cache_read_input_tokens === undefined
      ? {}
      : { cacheReadTokens: usage.cache_read_input_tokens },
  }
}

/**
 * Preprocess a reference song into the features a cover generation needs.
 * @param options - endpoint and credential.
 * @param request - the reference audio URL.
 * @param signal - caller cancellation.
 * @returns the feature id, the extracted lyrics, and the song structure.
 */
export async function preprocessCover(
  options: MiniMaxMediaOptions,
  request: { audioUrl: string },
  signal?: AbortSignal,
): Promise<{ coverFeatureId: string; formattedLyrics?: string; structureResult?: string; audioDuration?: number }> {
  const body = unwrap(
    await sendJson<MiniMaxCoverPreprocessResponse>(
      url(options.apiBaseURL, '/v1/music_cover_preprocess'),
      options,
      { body: { model: 'music-cover', audio_url: request.audioUrl } },
      signal,
      'MiniMax cover preprocessing',
    ),
    'MiniMax cover preprocessing',
  )
  if (body.cover_feature_id === undefined || body.cover_feature_id.length === 0) {
    throw new Error('MiniMax cover preprocessing returned no cover_feature_id')
  }
  return {
    coverFeatureId: body.cover_feature_id,
    ...body.formatted_lyrics === undefined ? {} : { formattedLyrics: body.formatted_lyrics },
    ...body.structure_result === undefined ? {} : { structureResult: body.structure_result },
    ...body.audio_duration === undefined ? {} : { audioDuration: body.audio_duration },
  }
}

/**
 * Generate a cover of a reference song.
 * @param options - endpoint, model, and credential.
 * @param request - the cover style, the reference, and the lyrics.
 * @param signal - caller cancellation.
 * @returns the temporary audio URL of the cover.
 */
export async function generateCover(
  options: MiniMaxMediaOptions,
  request: { prompt: string; audioUrl?: string; coverFeatureId?: string; lyrics?: string; format: string },
  signal?: AbortSignal,
): Promise<string> {
  const body = await sendJson<MiniMaxAudioResponse>(
    url(options.apiBaseURL, '/v1/music_generation'),
    options,
    {
      body: {
        model: 'music-cover',
        prompt: request.prompt,
        output_format: 'url',
        audio_setting: { format: request.format },
        ...request.audioUrl === undefined ? {} : { audio_url: request.audioUrl },
        ...request.coverFeatureId === undefined ? {} : { cover_feature_id: request.coverFeatureId },
        ...request.lyrics === undefined ? {} : { lyrics: request.lyrics },
      },
    },
    signal,
    'MiniMax cover generation',
  )
  const audio = unwrap(body, 'MiniMax cover generation').data?.audio
  if (audio === undefined || audio === null || audio.length === 0) {
    throw new Error('MiniMax cover generation returned no audio')
  }
  return audio
}

/**
 * Write song lyrics.
 * @param options - endpoint and credential.
 * @param request - the mode, the prompt, and the existing lyrics.
 * @param signal - caller cancellation.
 * @returns the title, the style tags, and the lyrics.
 */
export async function generateLyrics(
  options: MiniMaxMediaOptions,
  request: { mode: 'write_full_song' | 'edit'; prompt?: string; lyrics?: string; title?: string },
  signal?: AbortSignal,
): Promise<{ songTitle?: string; styleTags?: string; lyrics: string }> {
  const body = unwrap(
    await sendJson<MiniMaxLyricsResponse>(
      url(options.apiBaseURL, '/v1/lyrics_generation'),
      options,
      {
        body: {
          mode: request.mode,
          ...request.prompt === undefined ? {} : { prompt: request.prompt },
          ...request.lyrics === undefined ? {} : { lyrics: request.lyrics },
          ...request.title === undefined ? {} : { title: request.title },
        },
      },
      signal,
      'MiniMax lyrics generation',
    ),
    'MiniMax lyrics generation',
  )
  if (body.lyrics === undefined || body.lyrics.length === 0) {
    throw new Error('MiniMax lyrics generation returned no lyrics')
  }
  return {
    lyrics: body.lyrics,
    ...body.song_title === undefined ? {} : { songTitle: body.song_title },
    ...body.style_tags === undefined ? {} : { styleTags: body.style_tags },
  }
}

/**
 * Upload one file and return its MiniMax id.
 * @param options - endpoint and credential.
 * @param request - file bytes, display name, MIME type, and declared purpose.
 * @param signal - caller cancellation.
 * @returns the numeric file id MiniMax assigned.
 */
export async function uploadFile(
  options: MiniMaxMediaOptions,
  request: { bytes: Uint8Array; name: string; mediaType: string; purpose: string },
  signal?: AbortSignal,
): Promise<number> {
  const form = new FormData()
  form.set('purpose', request.purpose)
  form.set('file', new Blob([exactBuffer(request.bytes)], { type: request.mediaType }), request.name)
  const body = unwrap(
    await multipart<MiniMaxFileUploadResponse>(
      url(options.apiBaseURL, '/v1/files/upload'), options, form, 'MiniMax file upload', signal,
    ),
    'MiniMax file upload',
  )
  const fileId = body.file?.file_id
  if (fileId === undefined) throw new Error('MiniMax file upload returned no file_id')
  return fileId
}

/**
 * Stream a produced file into bounded chunks.
 * @param downloadUrl - the temporary URL MiniMax returned.
 * @param maxBytes - largest accepted body.
 * @param signal - caller cancellation.
 * @returns the bytes in order.
 */
export async function* downloadMedia(
  downloadUrl: string,
  maxBytes: number,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  let response: Response
  try {
    response = await fetch(downloadUrl, { ...signal === undefined ? {} : { signal } })
  } catch (error: unknown) {
    if (signal?.aborted === true) throw abortError(signal)
    throw new Error(`MiniMax media download failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new Error(`MiniMax media download answered HTTP ${String(response.status)}`)
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new Error(`MiniMax media exceeds the ${String(maxBytes)}-byte download limit`)
    yield bytes
    return
  }
  let total = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new Error(`MiniMax media exceeds the ${String(maxBytes)}-byte download limit`)
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}
