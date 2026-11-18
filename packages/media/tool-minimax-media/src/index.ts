/**
 * MiniMax media tools: image generation, speech synthesis, speech recognition,
 * music generation, and file upload.
 *
 * Everything authenticates with the same `MINIMAX_API_KEY` the `minimax` model
 * route uses. Whatever the endpoint produces by URL is downloaded immediately
 * and committed to the attachment store, because MiniMax's download links expire
 * within a day; whatever it produces by id (an uploaded file) is returned as the
 * `mm_file://` reference the video-understanding tool accepts.
 *
 * @module @deepseek-ai/dsh-tool-minimax-media
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-fs'
import {
  cloneVoice,
  countTokens,
  createAsyncSpeech,
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
} from './client.ts'
import type { MiniMaxMediaOptions } from './client.ts'

export {
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
} from './client.ts'
export type { ImageRequest, MiniMaxMediaOptions } from './client.ts'
export type {
  MiniMaxFileEntry,
  MiniMaxTranscription,
  MiniMaxVoiceCloneResponse,
  MiniMaxVoiceDesignResponse,
  MiniMaxVoiceEntry,
  MiniMaxVoiceGroup,
  MiniMaxVoiceListResponse,
} from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-minimax-media'

/** Registries these tools use. */
export const inject = ['tools']

/** MiniMax native API root. */
export const MINIMAX_API_BASE_URL = 'https://api.minimax.cn'

/** Credential reference shared with the model route, search, and video tools. */
export const MINIMAX_API_KEY_ENV = 'MINIMAX_API_KEY'

/** Image aspect ratios the endpoint documents. */
export const IMAGE_ASPECT_RATIOS = ['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9'] as const

/** Audio containers the synthesis endpoints accept. */
export const AUDIO_FORMATS = ['mp3', 'wav', 'flac', 'pcm', 'opus'] as const

/** Voice groups the voice-management endpoint reports. */
export const VOICE_TYPES = ['system', 'voice_cloning', 'voice_generation', 'all'] as const

/** Tones the speech-synthesis endpoint accepts. `whisper` is not on the 2.8 series. */
export const EMOTIONS = ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'whisper'] as const

/** Languages the recognition endpoint accepts in its `language` header. */
export const RECOGNITION_LANGUAGES = [
  'zh', 'yue', 'en', 'ja', 'ko', 'th', 'vi', 'id', 'ms', 'fil', 'ar', 'tr', 'fr', 'de', 'es', 'it', 'pt', 'pl', 'ru', 'uk',
] as const

/** Recognition response forms; the subtitle ones answer with text rather than JSON. */
export const TRANSCRIPTION_FORMATS = ['json', 'verbose_json', 'srt', 'vtt'] as const

/** Timestamp granularity the subtitle formats accept. */
export const TIMESTAMP_LEVELS = ['sentence', 'word'] as const

/** Purposes a file may be stored under; the upload endpoint accepts these. */
export const UPLOAD_PURPOSES = [
  'voice_clone', 'prompt_audio', 't2a_async_input', 'video_understanding', 'video_generation_input',
] as const

/** Purposes the file listing and deletion endpoints accept. */
export const FILE_PURPOSES = [
  'voice_clone', 'prompt_audio', 't2a_async', 't2a_async_input', 'video_generation',
] as const

/** Plugin configuration. */
export interface Config {
  /** Literal key; prefer {@link apiKeyEnv}. */
  apiKey: Volatile<string | undefined>
  /** Credential reference holding the MiniMax key. */
  apiKeyEnv: Volatile<string>
  /** Native API root. */
  apiBaseURL: Volatile<string>
  /** Image model. */
  imageModel: Volatile<string>
  /** Default aspect ratio for image generation. */
  aspectRatio: Volatile<string>
  /** Speech-synthesis model. */
  speechModel: Volatile<string>
  /** Default voice. */
  voiceId: Volatile<string>
  /** Music model. */
  musicModel: Volatile<string>
  /** Speech-recognition model. */
  asrModel: Volatile<string>
  /** Audio container for produced audio. */
  audioFormat: Volatile<string>
  /** Sample rate for produced audio. */
  sampleRate: Volatile<number>
  /** Largest accepted download, in bytes. */
  maxDownloadBytes: Volatile<number>
  /** Largest accepted input file for transcription or upload, in bytes. */
  maxUploadBytes: Volatile<number>
  /** Delay between two status reads of a background task, in milliseconds. */
  pollIntervalMs: Volatile<number>
  /** Upper bound on one background task, in milliseconds. */
  pollTimeoutMs: Volatile<number>
}

export const Config = z.object({
  apiKey: z.string().role('secret').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default(MINIMAX_API_KEY_ENV).volatile(),
  apiBaseURL: z.string().default(MINIMAX_API_BASE_URL).volatile(),
  imageModel: z.string().default('image-01').volatile(),
  aspectRatio: z.string().default('1:1').volatile(),
  speechModel: z.string().default('speech-2.8-hd').volatile(),
  voiceId: z.string().default('English_expressive_narrator').volatile(),
  musicModel: z.string().default('music-3.0').volatile(),
  asrModel: z.string().default('asr-1.0').volatile(),
  audioFormat: z.string().default('mp3').volatile(),
  sampleRate: z.number().step(1).min(8000).default(32_000).volatile(),
  maxDownloadBytes: z.number().step(1).min(1).default(128 * 1024 * 1024).volatile(),
  maxUploadBytes: z.number().step(1).min(1).default(50 * 1024 * 1024).volatile(),
  pollIntervalMs: z.number().step(1).min(1000).default(5000).volatile(),
  pollTimeoutMs: z.number().step(1).min(10_000).default(600_000).volatile(),
})

/** Live configuration read out of {@link Config}. */
type Section = { [K in keyof Config]: ReturnType<Config[K]['get']> }

/** Media type guessed from a file name, for the multipart uploads. */
export function mediaTypeOf(fileName: string): string {
  const extension = fileName.toLowerCase().split('.').pop() ?? ''
  switch (extension) {
    case 'mp3': return 'audio/mpeg'
    case 'wav': return 'audio/wav'
    case 'flac': return 'audio/flac'
    case 'm4a': case 'alac': return 'audio/mp4'
    case 'aac': return 'audio/aac'
    case 'opus': return 'audio/opus'
    case 'ogg': return 'audio/ogg'
    case 'aiff': return 'audio/aiff'
    case 'mp4': return 'video/mp4'
    case 'mov': return 'video/quicktime'
    case 'avi': return 'video/x-msvideo'
    case 'mkv': return 'video/x-matroska'
    default: return 'application/octet-stream'
  }
}

/**
 * Resolve the API key for one call.
 * @param ctx - plugin context.
 * @param ref - credential reference the deployment named.
 * @param literal - a key written directly into configuration.
 * @returns the usable key.
 */
async function resolveKey(ctx: Context, ref: CredentialRef, literal: string | undefined): Promise<string> {
  if (literal !== undefined && literal.length > 0) return literal
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const hit = await credentials.resolve(ref)
    if (hit !== undefined && hit.value.length > 0) return hit.value
  } else {
    const ambient = launchEnvironmentOf(ctx).get(ref)
    if (ambient !== undefined && ambient.value.length > 0) return ambient.value
  }
  throw new Error(
    `no MiniMax API key for ${ref}; store it through the credentials service (the web Models page writes it),`
    + ' or export it in the launching environment',
  )
}

/**
 * Resolve one call's options.
 * @param ctx - plugin context.
 * @param section - live configuration.
 * @returns options with the key resolved.
 */
async function optionsFor(ctx: Context, section: Section): Promise<MiniMaxMediaOptions> {
  return {
    apiBaseURL: section.apiBaseURL,
    apiKey: await resolveKey(ctx, credentialRef(section.apiKeyEnv), section.apiKey),
    imageModel: section.imageModel,
    speechModel: section.speechModel,
    musicModel: section.musicModel,
    asrModel: section.asrModel,
  }
}

/** Bytes read from a workspace file, plus what the multipart request needs. */
interface LocalFile {
  bytes: Uint8Array
  name: string
  mediaType: string
}

/**
 * Read one workspace file through the mounted filesystem, so sandbox policy
 * applies to what these tools may upload.
 * @param ctx - plugin context.
 * @param path - file path as the caller wrote it.
 * @param maxBytes - largest accepted file.
 * @param signal - caller cancellation.
 * @returns the bytes and the multipart metadata.
 */
async function readLocalFile(ctx: Context, path: string, maxBytes: number, signal: AbortSignal | undefined): Promise<LocalFile> {
  const fs = ctx.get('fs')
  if (fs === undefined) throw new Error(`this deployment mounts no filesystem service, so ${path} cannot be read`)
  const target = await fs.resolve(path, { ...signal === undefined ? {} : { signal } })
  const bytes = await fs.readBytes(target, signal, maxBytes)
  const name = target.displayPath.split(/[\\/]/u).pop() ?? 'upload'
  return { bytes, name, mediaType: mediaTypeOf(name) }
}

/** Extension a produced file should carry for a container format. */
function extensionFor(format: string): string {
  return format === 'pcm' ? 'pcm' : format
}

/** Store one downloaded artifact and describe where it went. */
async function storeArtifact(
  ctx: Context,
  sourceUrl: string,
  name: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<{ attachmentId: string; path?: string }> {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('this deployment mounts no attachment service, so produced media cannot be stored')
  const ref = await attachments.saveFileStream({
    data: downloadMedia(sourceUrl, maxBytes, signal),
    name,
    ...signal === undefined ? {} : { signal },
  })
  const path = attachments.fileHostPath(ref)
  return { attachmentId: ref.attachmentId, ...path === undefined ? {} : { path } }
}

/** Store bytes the provider returned inline rather than by URL. */
async function storeBytes(
  ctx: Context,
  bytes: Uint8Array,
  name: string,
): Promise<{ attachmentId: string; path?: string }> {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('this deployment mounts no attachment service, so produced media cannot be stored')
  const ref = await attachments.saveFile({ data: bytes, name })
  const path = attachments.fileHostPath(ref)
  return { attachmentId: ref.attachmentId, ...path === undefined ? {} : { path } }
}

/**
 * Register the media tools.
 * @param ctx - plugin context with the tool registry injected.
 * @param config - endpoints, models, defaults, and the credential reference.
 */
export function apply(ctx: Context, config: Config): void {
  const section = (): Section => ({
    apiKey: config.apiKey.get(),
    apiKeyEnv: config.apiKeyEnv.get(),
    apiBaseURL: config.apiBaseURL.get(),
    imageModel: config.imageModel.get(),
    aspectRatio: config.aspectRatio.get(),
    speechModel: config.speechModel.get(),
    voiceId: config.voiceId.get(),
    musicModel: config.musicModel.get(),
    asrModel: config.asrModel.get(),
    audioFormat: config.audioFormat.get(),
    sampleRate: config.sampleRate.get(),
    maxDownloadBytes: config.maxDownloadBytes.get(),
    maxUploadBytes: config.maxUploadBytes.get(),
    pollIntervalMs: config.pollIntervalMs.get(),
    pollTimeoutMs: config.pollTimeoutMs.get(),
  })

  ctx.tools.register(defineTool({
    name: 'minimax_image_generate',
    description:
      'Generate images with MiniMax from a text prompt, optionally guided by a reference image.'
      + ' Returns the stored file paths of the produced images.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'What the image should show (≤1500 characters).' },
      aspectRatio: { type: 'string', enum: [...IMAGE_ASPECT_RATIOS], description: 'Output aspect ratio; deployment default when omitted.' },
      count: { type: 'number', description: 'How many images, 1–9; defaults to 1.' },
      promptOptimizer: { type: 'boolean', description: 'Let MiniMax rewrite the prompt for a better result; defaults to false.' },
      seed: { type: 'number', description: 'Seed for a reproducible result; random when omitted.' },
      subjectReferenceUrl: { type: 'string', description: 'Public image URL used as a character reference (image-to-image).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          images: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                attachmentId: { type: 'string', required: true },
                path: { type: 'string' },
                url: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.images.map(image => image.path ?? image.attachmentId).join('\n'),
      }],
      presentationMeta: (_args, value) => ({
        paths: value.images.flatMap(image => image.path === undefined ? [] : [image.path]),
      }),
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const current = section()
      const options = await optionsFor(ctx, current)
      const count = Math.min(Math.max(Math.trunc(args.count ?? 1), 1), 9)
      const urls = await generateImages(options, {
        prompt: args.prompt,
        aspectRatio: args.aspectRatio ?? current.aspectRatio,
        count,
        promptOptimizer: args.promptOptimizer ?? false,
        ...args.seed === undefined ? {} : { seed: Math.trunc(args.seed) },
        ...args.subjectReferenceUrl === undefined ? {} : { subjectReferenceUrl: args.subjectReferenceUrl },
      }, exec.signal)
      const images = []
      for (const [index, sourceUrl] of urls.entries()) {
        const stored = await storeArtifact(ctx, sourceUrl, `minimax-image-${String(index + 1)}.png`, current.maxDownloadBytes, exec.signal)
        images.push({ ...stored, url: sourceUrl })
      }
      return { images }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'minimax_speech_synthesize',
    description: 'Synthesize speech from text with MiniMax and return the stored audio file path.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to speak (≤10,000 characters).' },
      voiceId: { type: 'string', description: 'MiniMax voice id; deployment default when omitted. List them with minimax_list_voices.' },
      format: { type: 'string', enum: [...AUDIO_FORMATS], description: 'Audio container; deployment default when omitted.' },
      emotion: {
        type: 'string',
        enum: [...EMOTIONS],
        description: 'Tone of the voice; not supported by the 2.8 speech models.',
      },
      speed: { type: 'number', description: 'Speaking rate, 0.5–2.0; defaults to 1.' },
      volume: { type: 'number', description: 'Volume, above 0 and up to 10; defaults to 1.' },
      pitch: { type: 'number', description: 'Pitch shift, −12 to 12; defaults to 0.' },
      languageBoost: {
        type: 'string',
        description: 'Language to boost recognition of, such as Chinese, English, Japanese, or auto.',
      },
      channel: { type: 'number', description: 'Audio channels: 1 for mono, 2 for stereo; defaults to 1.' },
      bitrate: { type: 'number', description: 'Audio bitrate for mp3: 32000, 64000, 128000, or 256000.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attachmentId: { type: 'string', required: true },
          path: { type: 'string' },
          url: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.path ?? value.attachmentId }],
      presentationMeta: (_args, value) => ({ ...value.path === undefined ? {} : { path: value.path } }),
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const current = section()
      const options = await optionsFor(ctx, current)
      const format = args.format ?? current.audioFormat
      const sourceUrl = await synthesizeSpeech(options, {
        text: args.text,
        voiceId: args.voiceId ?? current.voiceId,
        format,
        sampleRate: current.sampleRate,
        ...args.emotion === undefined ? {} : { emotion: args.emotion },
        ...args.speed === undefined ? {} : { speed: args.speed },
        ...args.volume === undefined ? {} : { volume: args.volume },
        ...args.pitch === undefined ? {} : { pitch: args.pitch },
        ...args.languageBoost === undefined ? {} : { languageBoost: args.languageBoost },
        ...args.channel === undefined ? {} : { channel: args.channel },
        ...args.bitrate === undefined ? {} : { bitrate: args.bitrate },
      }, exec.signal)
      const stored = await storeArtifact(ctx, sourceUrl, `minimax-speech.${extensionFor(format)}`, current.maxDownloadBytes, exec.signal)
      return { ...stored, url: sourceUrl }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'minimax_speech_transcribe',
    description:
      'Transcribe an audio file with MiniMax speech recognition and return the text.'
      + ' The verbose form also reports who spoke when; the subtitle forms return SRT or VTT.',
    parameters: {
      path: { type: 'string', required: true, description: 'Audio file path in the workspace.' },
      language: { type: 'string', enum: [...RECOGNITION_LANGUAGES], description: 'Language of the audio; omit for mixed-language audio.' },
      responseFormat: {
        type: 'string',
        enum: [...TRANSCRIPTION_FORMATS],
        description: 'json for plain text, verbose_json for speaker segments, srt or vtt for subtitles; defaults to json.',
      },
      timestampLevel: {
        type: 'string',
        enum: [...TIMESTAMP_LEVELS],
        description: 'Timestamp granularity for the subtitle forms; defaults to sentence.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          durationSeconds: { type: 'number' },
          speakerCount: { type: 'number' },
          segments: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                speaker: { type: 'string' },
                text: { type: 'string' },
                startSeconds: { type: 'number' },
                endSeconds: { type: 'number' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const current = section()
      const options = await optionsFor(ctx, current)
      const file = await readLocalFile(ctx, args.path, current.maxUploadBytes, exec.signal)
      const result = await transcribe(options, {
        bytes: file.bytes,
        name: file.name,
        mediaType: file.mediaType,
        responseFormat: args.responseFormat ?? 'json',
        ...args.language === undefined ? {} : { language: args.language },
        ...args.timestampLevel === undefined ? {} : { timestampLevel: args.timestampLevel },
      }, exec.signal)
      if (result.text === undefined) throw new Error('MiniMax transcription returned no text')
      const segments = (result.segments ?? []).map(segment => ({
        ...segment.speaker === undefined ? {} : { speaker: segment.speaker },
        ...segment.text === undefined ? {} : { text: segment.text },
        ...segment.start === undefined ? {} : { startSeconds: segment.start },
        ...segment.end === undefined ? {} : { endSeconds: segment.end },
      }))
      return {
        text: result.text,
        ...result.duration === undefined ? {} : { durationSeconds: result.duration },
        ...result.n_speakers === undefined ? {} : { speakerCount: result.n_speakers },
        ...segments.length === 0 ? {} : { segments },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'minimax_music_generate',
    description: 'Generate a song with MiniMax from a style prompt and optional lyrics, returning the stored audio path.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Style and mood of the music (1–2000 characters).' },
      lyrics: { type: 'string', description: 'Lyrics with [Verse]/[Chorus] tags; omit for instrumental output.' },
      instrumental: { type: 'boolean', description: 'Produce instrumental music with no vocals.' },
      format: { type: 'string', enum: [...AUDIO_FORMATS], description: 'Audio container; deployment default when omitted.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attachmentId: { type: 'string', required: true },
          path: { type: 'string' },
          url: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.path ?? value.attachmentId }],
      presentationMeta: (_args, value) => ({ ...value.path === undefined ? {} : { path: value.path } }),
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const current = section()
      const options = await optionsFor(ctx, current)
      const format = args.format ?? current.audioFormat
      const sourceUrl = await generateMusic(options, {
        prompt: args.prompt,
        instrumental: args.instrumental ?? args.lyrics === undefined,
        format,
        sampleRate: current.sampleRate,
        ...args.lyrics === undefined ? {} : { lyrics: args.lyrics },
      }, exec.signal)
      const stored = await storeArtifact(ctx, sourceUrl, `minimax-music.${extensionFor(format)}`, current.maxDownloadBytes, exec.signal)
      return { ...stored, url: sourceUrl }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'minimax_file_upload',
    description:
      'Upload a file to MiniMax and return the mm_file:// reference other MiniMax tools accept.'
      + ' Use purpose video_understanding for a video that is too large to pass by URL.',
    parameters: {
      path: { type: 'string', required: true, description: 'File path in the workspace.' },
      purpose: {
        type: 'string',
        enum: [...UPLOAD_PURPOSES],
        required: true,
        description: 'Declared upload purpose; video_understanding for videos, video_generation_input for generation inputs.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fileId: { type: 'number', required: true },
          reference: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.reference }],
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const current = section()
      const options = await optionsFor(ctx, current)
      const file = await readLocalFile(ctx, args.path, current.maxUploadBytes, exec.signal)
      const fileId = await uploadFile(options, {
        bytes: file.bytes,
        name: file.name,
        mediaType: file.mediaType,
        purpose: args.purpose,
      }, exec.signal)
      return { fileId, reference: `mm_file://${String(fileId)}` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'minimax_list_voices',
    description:
      'List the voices this MiniMax account may synthesize with: the built-in system voices,'
      + ' the voices cloned from samples, and the voices designed from a description.'
      + ' Use the returned voice id with minimax_speech_synthesize.',
    parameters: {
      voiceType: {
        type: 'string',
        enum: [...VOICE_TYPES],
        description: 'Which voices to read; defaults to all of them.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          voices: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                voiceId: { type: 'string', required: true },
                voiceName: { type: 'string' },
                group: { type: 'string', required: true },
                description: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.voices
          .map(voice => `${voice.voiceId}${voice.voiceName === undefined ? '' : ` (${voice.voiceName})`}`)
          .join('\n'),
      }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const current = section()
      const options = await optionsFor(ctx, current)
      const voices = await listVoices(options, { voiceType: args.voiceType ?? 'all' }, exec.signal)
      return {
        voices: voices.map(entry => ({
          voiceId: entry.voice.voice_id,
          ...entry.voice.voice_name === undefined ? {} : { voiceName: entry.voice.voice_name },
          group: entry.group,
          ...entry.voice.description === undefined ? {} : { description: entry.voice.description },
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'minimax_voice_clone',
    description:
      'Clone a voice from an audio sample so speech synthesis can use it as its own voice.'
      + ' The sample must be 10 seconds to 5 minutes of mp3, m4a, or wav.'
      + ' MiniMax deletes a cloned voice that is never used within 7 days.',
    parameters: {
      path: { type: 'string', required: true, description: 'Sample audio file in the workspace (mp3, m4a, or wav).' },
      voiceId: {
        type: 'string',
        required: true,
        description: 'Id for the cloned voice: 8–256 characters, starting with a letter, using letters, digits, - and _.',
      },
      previewText: { type: 'string', description: 'Text to read in the cloned voice as a preview (≤1000 characters).' },
      previewModel: { type: 'string', description: 'Speech model for the preview, such as speech-2.8-hd; required with previewText.' },
      promptAudioPath: { type: 'string', description: 'Short sample under 8 seconds that improves the cloning accuracy.' },
      promptText: { type: 'string', description: 'Transcript of the short sample; must match it and end with punctuation.' },
      textValidation: { type: 'string', description: 'Expected transcript of the sample, checked against the recognition of it (≤200 characters).' },
      accuracy: { type: 'number', description: 'Similarity threshold for that check, 0–1; defaults to 0.7.' },
      languageBoost: { type: 'string', description: 'Language to boost recognition of, such as Chinese, English, or auto.' },
      noiseReduction: { type: 'boolean', description: 'Reduce noise in the cloned voice.' },
      volumeNormalization: { type: 'boolean', description: 'Normalize the volume of the cloned voice.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          voiceId: { type: 'string', required: true },
          previewAttachmentId: { type: 'string' },
          previewPath: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.previewPath ?? value.voiceId,
      }],
      presentationMeta: (_args, value) => ({ ...value.previewPath === undefined ? {} : { path: value.previewPath } }),
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const current = section()
      const options = await optionsFor(ctx, current)
      const sample = await readLocalFile(ctx, args.path, current.maxUploadBytes, exec.signal)
      const fileId = await uploadFile(options, {
        bytes: sample.bytes,
        name: sample.name,
        mediaType: sample.mediaType,
        purpose: 'voice_clone',
      }, exec.signal)
      // A short sample with its transcript raises the clone's similarity, so
      // it is uploaded under its own purpose before the clone call.
      let clonePrompt: { promptAudio: number; promptText: string } | undefined
      if (args.promptAudioPath !== undefined) {
        const prompt = await readLocalFile(ctx, args.promptAudioPath, current.maxUploadBytes, exec.signal)
        const promptFileId = await uploadFile(options, {
          bytes: prompt.bytes,
          name: prompt.name,
          mediaType: prompt.mediaType,
          purpose: 'prompt_audio',
        }, exec.signal)
        clonePrompt = { promptAudio: promptFileId, promptText: args.promptText ?? '' }
      }
      const cloned = await cloneVoice(options, {
        fileId,
        voiceId: args.voiceId,
        ...clonePrompt === undefined ? {} : { clonePrompt },
        ...args.previewText === undefined ? {} : { text: args.previewText },
        ...args.previewModel === undefined ? {} : { model: args.previewModel },
        ...args.languageBoost === undefined ? {} : { languageBoost: args.languageBoost },
        ...args.textValidation === undefined ? {} : { textValidation: args.textValidation },
        ...args.accuracy === undefined ? {} : { accuracy: args.accuracy },
        ...args.noiseReduction === undefined ? {} : { needNoiseReduction: args.noiseReduction },
        ...args.volumeNormalization === undefined ? {} : { needVolumeNormalization: args.volumeNormalization },
      }, exec.signal)
      if (cloned.previewUrl === undefined) return { voiceId: cloned.voiceId }
      const preview = await storeArtifact(
        ctx, cloned.previewUrl, `minimax-voice-${cloned.voiceId}.mp3`, current.maxDownloadBytes, exec.signal,
      )
      return {
        voiceId: cloned.voiceId,
        previewAttachmentId: preview.attachmentId,
        ...preview.path === undefined ? {} : { previewPath: preview.path },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'minimax_voice_design',
    description:
      'Design a voice from a description and return its id with a preview recording.'
      + ' The new voice can be used with minimax_speech_synthesize.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'What the voice should sound like, for example a deep and measured narrator.' },
      previewText: { type: 'string', required: true, description: 'Text to read in the designed voice as a preview (≤500 characters).' },
      voiceId: { type: 'string', description: 'Id for the designed voice; MiniMax generates a unique one when omitted.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          voiceId: { type: 'string', required: true },
          previewAttachmentId: { type: 'string' },
          previewPath: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.previewPath ?? value.voiceId }],
      presentationMeta: (_args, value) => ({ ...value.previewPath === undefined ? {} : { path: value.previewPath } }),
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const current = section()
      const options = await optionsFor(ctx, current)
      const designed = await designVoice(options, {
        prompt: args.prompt,
        previewText: args.previewText,
        ...args.voiceId === undefined ? {} : { voiceId: args.voiceId },
      }, exec.signal)
      if (designed.previewAudio === undefined) return { voiceId: designed.voiceId }
      const preview = await storeBytes(ctx, designed.previewAudio, `minimax-voice-${designed.voiceId}.mp3`)
      return {
        voiceId: designed.voiceId,
        previewAttachmentId: preview.attachmentId,
        ...preview.path === undefined ? {} : { previewPath: preview.path },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'minimax_voice_delete',
    description:
      'Delete a MiniMax voice that was cloned from a sample or designed from a description.'
      + ' The id cannot be used again afterwards.',
    parameters: {
      voiceId: { type: 'string', required: true, description: 'The voice id to delete.' },
      voiceType: {
        type: 'string',
        enum: ['voice_cloning', 'voice_generation'],
        required: true,
        description: 'Whether the voice was cloned or designed.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { voiceId: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `MiniMax voice ${value.voiceId} deleted.` }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const current = section()
      const options = await optionsFor(ctx, current)
      const voiceId = await deleteVoice(options, {
        voiceType: args.voiceType,
        voiceId: args.voiceId,
      }, exec.signal)
      return { voiceId }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'minimax_speech_synthesize_async',
    description:
      'Synthesize a long text with MiniMax as a background task. The synchronous endpoint takes at most'
      + ' 10,000 characters; this one takes 50,000, and a file may carry a million. Returns the stored'
      + ' audio file path.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to speak (≤50,000 characters).' },
      voiceId: { type: 'string', description: 'MiniMax voice id; deployment default when omitted.' },
      format: { type: 'string', enum: [...AUDIO_FORMATS], description: 'Audio container; deployment default when omitted.' },
      emotion: { type: 'string', enum: [...EMOTIONS], description: 'Tone of the voice.' },
      speed: { type: 'number', description: 'Speaking rate, 0.5–2.0; defaults to 1.' },
      volume: { type: 'number', description: 'Volume, above 0 and up to 10; defaults to 1.' },
      pitch: { type: 'number', description: 'Pitch shift, −12 to 12; defaults to 0.' },
      languageBoost: { type: 'string', description: 'Language to boost recognition of, such as Chinese, English, or auto.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          attachmentId: { type: 'string' },
          path: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.path === undefined
          ? `MiniMax speech task ${value.taskId} ended ${value.status}.`
          : `MiniMax speech task ${value.taskId} saved to ${value.path}.`,
      }],
      presentationMeta: (_args, value) => ({ ...value.path === undefined ? {} : { path: value.path } }),
    },
    timeoutMs: 900_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const current = section()
      const options = await optionsFor(ctx, current)
      const format = args.format ?? current.audioFormat
      const created = await createAsyncSpeech(options, {
        text: args.text,
        voiceId: args.voiceId ?? current.voiceId,
        format,
        sampleRate: current.sampleRate,
        ...args.emotion === undefined ? {} : { emotion: args.emotion },
        ...args.speed === undefined ? {} : { speed: args.speed },
        ...args.volume === undefined ? {} : { volume: args.volume },
        ...args.pitch === undefined ? {} : { pitch: args.pitch },
        ...args.languageBoost === undefined ? {} : { languageBoost: args.languageBoost },
      }, exec.signal)
      const deadline = Date.now() + current.pollTimeoutMs
      let fileId = created.fileId
      let status = 'processing'
      while (fileId === undefined && Date.now() < deadline) {
        exec.signal.throwIfAborted()
        const polled = await queryAsyncSpeech(options, created.taskId, exec.signal)
        status = polled.status
        fileId = polled.fileId
        if (fileId === undefined && polled.status !== 'failed' && polled.status !== 'expired') {
          await new Promise(resolve => setTimeout(resolve, current.pollIntervalMs))
        }
      }
      if (fileId === undefined) {
        throw new Error(`MiniMax speech task ${created.taskId} ended ${status} without an audio file`)
      }
      const file = await retrieveFile(options, fileId, exec.signal)
      const sourceUrl = file?.download_url
      if (sourceUrl === undefined) throw new Error(`MiniMax file ${String(fileId)} carried no download URL`)
      const stored = await storeArtifact(
        ctx, sourceUrl, `minimax-speech-${created.taskId}.${extensionFor(format)}`, current.maxDownloadBytes, exec.signal,
      )
      return {
        taskId: created.taskId,
        status,
        attachmentId: stored.attachmentId,
        ...stored.path === undefined ? {} : { path: stored.path },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'minimax_music_cover',
    description:
      'Make a cover of a reference song with MiniMax. Give it the style of the cover and either the'
      + ' reference song URL or a cover feature id from minimax_music_cover_preprocess.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The style of the cover (10–300 characters).' },
      audioUrl: { type: 'string', description: 'Public URL of the reference song; mutually exclusive with coverFeatureId.' },
      coverFeatureId: { type: 'string', description: 'Feature id from minimax_music_cover_preprocess; needs lyrics.' },
      lyrics: { type: 'string', description: 'Lyrics for the cover (10–1000 characters); required with coverFeatureId.' },
      format: { type: 'string', enum: ['mp3', 'wav', 'pcm'], description: 'Audio container; deployment default when omitted.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attachmentId: { type: 'string', required: true },
          path: { type: 'string' },
          url: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.path ?? value.attachmentId }],
      presentationMeta: (_args, value) => ({ ...value.path === undefined ? {} : { path: value.path } }),
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const current = section()
      const options = await optionsFor(ctx, current)
      if (args.audioUrl === undefined && args.coverFeatureId === undefined) {
        throw new Error('a MiniMax cover needs a reference song URL or a cover feature id')
      }
      if (args.audioUrl !== undefined && args.coverFeatureId !== undefined) {
        throw new Error('a MiniMax cover takes a reference song URL or a cover feature id, never both')
      }
      if (args.coverFeatureId !== undefined && args.lyrics === undefined) {
        throw new Error('a cover built from a feature id needs the lyrics to sing')
      }
      const format = args.format ?? current.audioFormat
      const sourceUrl = await generateCover(options, {
        prompt: args.prompt,
        ...args.audioUrl === undefined ? {} : { audioUrl: args.audioUrl },
        ...args.coverFeatureId === undefined ? {} : { coverFeatureId: args.coverFeatureId },
        ...args.lyrics === undefined ? {} : { lyrics: args.lyrics },
        format,
      }, exec.signal)
      const stored = await storeArtifact(
        ctx, sourceUrl, `minimax-cover.${extensionFor(format)}`, current.maxDownloadBytes, exec.signal,
      )
      return { ...stored, url: sourceUrl }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'minimax_music_cover_preprocess',
    description:
      'Read a reference song and extract its lyrics and structure, which minimax_music_cover then turns'
      + ' into a cover. The feature id is valid for 24 hours.',
    parameters: {
      audioUrl: { type: 'string', required: true, description: 'Public URL of the reference song (6 seconds to 6 minutes).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          coverFeatureId: { type: 'string', required: true },
          formattedLyrics: { type: 'string' },
          structureResult: { type: 'string' },
          audioDurationSeconds: { type: 'number' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.formattedLyrics ?? value.coverFeatureId,
      }],
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const current = section()
      const options = await optionsFor(ctx, current)
      const preprocessed = await preprocessCover(options, { audioUrl: args.audioUrl }, exec.signal)
      return {
        coverFeatureId: preprocessed.coverFeatureId,
        ...preprocessed.formattedLyrics === undefined ? {} : { formattedLyrics: preprocessed.formattedLyrics },
        ...preprocessed.structureResult === undefined ? {} : { structureResult: preprocessed.structureResult },
        ...preprocessed.audioDuration === undefined ? {} : { audioDurationSeconds: preprocessed.audioDuration },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'minimax_lyrics_generate',
    description:
      'Write song lyrics with MiniMax, or edit and continue existing ones. The result can be sung by'
      + ' minimax_music_generate.',
    parameters: {
      mode: {
        type: 'string',
        enum: ['write_full_song', 'edit'],
        required: true,
        description: 'Write a whole song, or edit and continue existing lyrics.',
      },
      prompt: { type: 'string', description: 'What the song should be about (≤2000 characters).' },
      lyrics: { type: 'string', description: 'Existing lyrics to edit or continue (≤3500 characters).' },
      title: { type: 'string', description: 'Title to keep in the result.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lyrics: { type: 'string', required: true },
          songTitle: { type: 'string' },
          styleTags: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.songTitle === undefined ? value.lyrics : `${value.songTitle}\n\n${value.lyrics}`,
      }],
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const current = section()
      const options = await optionsFor(ctx, current)
      const written = await generateLyrics(options, {
        mode: args.mode,
        ...args.prompt === undefined ? {} : { prompt: args.prompt },
        ...args.lyrics === undefined ? {} : { lyrics: args.lyrics },
        ...args.title === undefined ? {} : { title: args.title },
      }, exec.signal)
      return {
        lyrics: written.lyrics,
        ...written.songTitle === undefined ? {} : { songTitle: written.songTitle },
        ...written.styleTags === undefined ? {} : { styleTags: written.styleTags },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'minimax_file_list',
    description: 'List the files MiniMax stores for one purpose, such as uploaded videos or voice samples.',
    parameters: {
      purpose: {
        type: 'string',
        enum: [...FILE_PURPOSES],
        required: true,
        description: 'Which stored files to read.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                fileId: { type: 'number', required: true },
                filename: { type: 'string' },
                bytes: { type: 'number' },
                purpose: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.files.map(file => `${String(file.fileId)} ${file.filename ?? ''}`).join('\n'),
      }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const current = section()
      const options = await optionsFor(ctx, current)
      const files = await listFiles(options, { purpose: args.purpose }, exec.signal)
      return {
        files: files.flatMap(file => file.file_id === undefined
          ? []
          : [{
            fileId: file.file_id,
            ...file.filename === undefined ? {} : { filename: file.filename },
            ...file.bytes === undefined ? {} : { bytes: file.bytes },
            ...file.purpose === undefined ? {} : { purpose: file.purpose },
          }]),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'minimax_file_delete',
    description: 'Delete a file MiniMax stores, such as an uploaded video that is no longer needed.',
    parameters: {
      fileId: { type: 'number', required: true, description: 'The file id to delete.' },
      purpose: {
        type: 'string',
        enum: [...FILE_PURPOSES],
        required: true,
        description: 'The purpose the file was stored under.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { fileId: { type: 'number', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `MiniMax file ${String(value.fileId)} deleted.` }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const current = section()
      const options = await optionsFor(ctx, current)
      return { fileId: await deleteFile(options, { fileId: args.fileId, purpose: args.purpose }, exec.signal) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'minimax_file_download',
    description:
      'Download a file MiniMax stores and keep it in the workspace. Use it to bring back an uploaded'
      + ' video or a generated audio file.',
    parameters: {
      fileId: { type: 'number', required: true, description: 'The file id to download.' },
      name: { type: 'string', description: 'Name to save the file under; defaults to the stored name.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fileId: { type: 'number', required: true },
          attachmentId: { type: 'string' },
          path: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.path ?? `MiniMax file ${String(value.fileId)}` }],
      presentationMeta: (_args, value) => ({ ...value.path === undefined ? {} : { path: value.path } }),
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const current = section()
      const options = await optionsFor(ctx, current)
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw new Error('this deployment mounts no attachment service, so the downloaded file cannot be stored')
      }
      const file = await retrieveFile(options, args.fileId, exec.signal)
      const name = args.name ?? file?.filename ?? `minimax-file-${String(args.fileId)}`
      const ref = await attachments.saveFileStream({
        data: downloadFileContent(options, args.fileId, current.maxDownloadBytes, exec.signal),
        name,
        signal: exec.signal,
      })
      const path = attachments.fileHostPath(ref)
      return {
        fileId: args.fileId,
        attachmentId: ref.attachmentId,
        ...path === undefined ? {} : { path },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'minimax_count_tokens',
    description:
      'Count the tokens a message would cost on a MiniMax model, without generating anything.'
      + ' Use it before sending a long text to check it fits the context.',
    parameters: {
      text: { type: 'string', required: true, description: 'The text to measure.' },
      model: {
        type: 'string',
        enum: ['MiniMax-M3.1-Flash', 'MiniMax-M3'],
        description: 'The model to measure against; deployment default when omitted.',
      },
      serviceTier: {
        type: 'string',
        enum: ['standard', 'priority'],
        description: 'Admission tier to measure at; priority costs 1.5× and MiniMax-M3.1-Flash rejects it.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          inputTokens: { type: 'number', required: true },
          cacheReadTokens: { type: 'number' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${String(value.inputTokens)} input tokens`
          + (value.cacheReadTokens === undefined ? '' : `, ${String(value.cacheReadTokens)} read from cache`),
      }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const current = section()
      const options = await optionsFor(ctx, current)
      const counted = await countTokens(options, {
        model: args.model ?? 'MiniMax-M3.1-Flash',
        messages: [{ role: 'user', content: args.text }],
        ...args.serviceTier === undefined ? {} : { serviceTier: args.serviceTier },
      }, exec.signal)
      return {
        inputTokens: counted.inputTokens,
        ...counted.cacheReadTokens === undefined ? {} : { cacheReadTokens: counted.cacheReadTokens },
      }
    },
  }))
}
