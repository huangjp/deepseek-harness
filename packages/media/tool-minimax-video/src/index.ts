/**
 * MiniMax video tools: generate a video, and ask a model what happens in one.
 *
 * Both tools authenticate with the same MiniMax API key the `minimax` model
 * route uses. Generation is a two-step server task, so the tool creates it,
 * polls until it settles, and commits the finished MP4 into the attachment
 * store — the durable reference is what the session keeps, because the
 * download URL MiniMax returns expires.
 *
 * @module @deepseek-ai/dsh-tool-minimax-video
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-attachment'
import {
  cancelVideoTask,
  createContextIrTask,
  createHailuoVideoTask,
  createRegenerationTask,
  createVideoTask,
  downloadVideo,
  listVideoTasks,
  retrieveFile,
  understandVideo,
  waitForHailuoVideoTask,
  waitForVideoTask,
} from './client.ts'
import type { MiniMaxVideoOptions } from './client.ts'
import type { MiniMaxVideoCreateRequest } from './types.ts'

export {
  cancelVideoTask,
  createContextIrTask,
  createHailuoVideoTask,
  createRegenerationTask,
  createVideoTask,
  downloadVideo,
  listVideoTasks,
  queryHailuoVideoTask,
  queryVideoTask,
  retrieveFile,
  understandVideo,
  waitForHailuoVideoTask,
  waitForVideoTask,
} from './client.ts'
export type { MiniMaxVideoOptions, UnderstandRequest } from './client.ts'
export type {
  MiniMaxVideoContent,
  MiniMaxVideoCreateRequest,
  MiniMaxVideoRole,
  MiniMaxVideoTask,
} from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-minimax-video'

/** Registries and services these tools use. */
export const inject = ['tools']

/** MiniMax native API root, where task endpoints live. */
export const MINIMAX_API_BASE_URL = 'https://api.minimax.cn'

/** MiniMax Anthropic-compatible root, where understanding requests go. */
export const MINIMAX_CHAT_BASE_URL = 'https://api.minimax.cn/anthropic'

/** Credential reference shared with the model route and the search provider. */
export const MINIMAX_API_KEY_ENV = 'MINIMAX_API_KEY'

/** Video models this tool offers. */
export const MINIMAX_VIDEO_MODELS = ['MiniMax-H3', 'MiniMax-H3-Highspeed', 'MiniMax-H3-Lite', 'MiniMax-H3-Max'] as const

/** Resolutions the endpoint documents. */
export const MINIMAX_VIDEO_RESOLUTIONS = ['480P', '768P', '2K'] as const

/** The older endpoint's models, which reach 1080P. */
export const MINIMAX_HAILUO_MODELS = [
  'MiniMax-Hailuo-2.3',
  'MiniMax-Hailuo-2.3-Fast',
  'MiniMax-Hailuo-02',
  'T2V-01-Director',
  'T2V-01',
  'I2V-01-Director',
  'I2V-01-live',
  'I2V-01',
  'S2V-01',
] as const

/** Plugin configuration: endpoints, defaults, and one credential. */
export interface Config {
  /** Literal key; prefer {@link apiKeyEnv}. */
  apiKey: Volatile<string | undefined>
  /** Credential reference holding the MiniMax key. */
  apiKeyEnv: Volatile<string>
  /** Native API root for task endpoints. */
  apiBaseURL: Volatile<string>
  /** Anthropic-compatible root for understanding. */
  chatBaseURL: Volatile<string>
  /** Model used when the caller names none. */
  videoModel: Volatile<string>
  /** Resolution used when the caller names none. */
  resolution: Volatile<string>
  /** Duration used when the caller names none. */
  durationSeconds: Volatile<number>
  /** Aspect ratio used when the caller names none. */
  ratio: Volatile<string>
  /** Delay between two status reads, in milliseconds. */
  pollIntervalMs: Volatile<number>
  /** Upper bound on one create-and-poll operation, in milliseconds. */
  pollTimeoutMs: Volatile<number>
  /** Largest accepted video download, in bytes. */
  maxDownloadBytes: Volatile<number>
  /** Output cap for one understanding turn. */
  maxTokens: Volatile<number>
  /** Model that answers the understanding turn. */
  understandingModel: Volatile<string>
}

export const Config = z.object({
  apiKey: z.string().role('secret').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default(MINIMAX_API_KEY_ENV).volatile(),
  apiBaseURL: z.string().default(MINIMAX_API_BASE_URL).volatile(),
  chatBaseURL: z.string().default(MINIMAX_CHAT_BASE_URL).volatile(),
  videoModel: z.string().default('MiniMax-H3').volatile(),
  resolution: z.string().default('768P').volatile(),
  durationSeconds: z.number().step(1).min(4).max(15).default(6).volatile(),
  ratio: z.string().default('16:9').volatile(),
  pollIntervalMs: z.number().step(1).min(1000).default(10_000).volatile(),
  pollTimeoutMs: z.number().step(1).min(10_000).default(600_000).volatile(),
  maxDownloadBytes: z.number().step(1).min(1).default(256 * 1024 * 1024).volatile(),
  maxTokens: z.number().step(1).min(1).default(4096).volatile(),
  understandingModel: z.string().default('MiniMax-M3.1-Flash').volatile(),
})

/** Live configuration read out of {@link Config}. */
type Section = { [K in keyof Config]: ReturnType<Config[K]['get']> }

/**
 * Resolve the API key for one call: configuration literal, then the credential
 * store, then the launching environment. A route with no key fails the tool
 * call with an actionable message rather than sending an anonymous request.
 * @param ctx - plugin context.
 * @param ref - credential reference the deployment named.
 * @param literal - a key written directly into configuration, when present.
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
 * Options for one call, with the key already resolved.
 * @param ctx - plugin context.
 * @param section - the live configuration.
 * @param literal - a key written directly into configuration.
 * @returns resolved options.
 */
async function optionsFor(ctx: Context, section: Section, literal: string | undefined): Promise<MiniMaxVideoOptions> {
  const apiKey = await resolveKey(ctx, credentialRef(section.apiKeyEnv), literal)
  return {
    apiBaseURL: section.apiBaseURL,
    chatBaseURL: section.chatBaseURL,
    apiKey,
    videoModel: section.videoModel,
    resolution: section.resolution,
    durationSeconds: section.durationSeconds,
    ratio: section.ratio,
    pollIntervalMs: section.pollIntervalMs,
    pollTimeoutMs: section.pollTimeoutMs,
    maxDownloadBytes: section.maxDownloadBytes,
    maxTokens: section.maxTokens,
    understandingModel: section.understandingModel,
  }
}

/** A generation request resolved from model-supplied arguments. */
interface GenerateArgs {
  prompt: string
  model?: string
  resolution?: string
  durationSeconds?: number
  ratio?: string
  firstFrameImageUrl?: string
  lastFrameImageUrl?: string
  referenceImageUrls?: readonly string[]
  referenceVideoUrl?: string
  referenceAudioUrl?: string
  promptExpansionMode?: 'disabled' | 'balanced' | 'quality'
}

/**
 * The resolutions each video model serves.
 *
 * MiniMax refuses a resolution a model does not produce, so the tool checks
 * the request against this table before it reaches the provider and reports
 * the conflict as an argument problem rather than an opaque `400`.
 */
const MODEL_RESOLUTIONS: Readonly<Record<string, readonly string[]>> = {
  'MiniMax-H3': ['768P', '2K'],
  'MiniMax-H3-Highspeed': ['480P', '768P'],
  'MiniMax-H3-Lite': ['480P', '768P'],
  'MiniMax-H3-Max': ['480P', '768P'],
}

/**
 * The clip lengths each video model serves.
 *
 * The Max model starts at five seconds, so a shorter request is refused by
 * MiniMax rather than rounded.
 */
const MODEL_DURATIONS: Readonly<Record<string, readonly number[]>> = {
  'MiniMax-H3-Max': [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
}

/**
 * Build the wire request for one generation.
 *
 * A generation is either an image-to-video one or a reference one; MiniMax
 * refuses a request that carries both, so the tool picks the first form the
 * arguments describe and refuses a mixture.
 * @param options - resolved defaults.
 * @param args - the model's arguments.
 * @returns the creation body.
 * @throws when the arguments mix image-to-video with reference media, or name a
 *   resolution the chosen model does not serve.
 */
export function generationRequest(options: MiniMaxVideoOptions, args: GenerateArgs): MiniMaxVideoCreateRequest {
  const model = args.model ?? options.videoModel
  const resolution = args.resolution ?? options.resolution
  const served = MODEL_RESOLUTIONS[model]
  if (served !== undefined && !served.includes(resolution)) {
    throw new Error(
      `MiniMax model ${model} does not produce ${resolution}; it serves ${served.join(', ')}`,
    )
  }
  const duration = args.durationSeconds ?? options.durationSeconds
  const lengths = MODEL_DURATIONS[model]
  if (lengths !== undefined && !lengths.includes(duration)) {
    throw new Error(
      `MiniMax model ${model} does not produce a ${String(duration)}-second clip;`
      + ` it serves ${lengths.map(String).join('–')} seconds`,
    )
  }
  const referenceImageUrls = args.referenceImageUrls ?? []
  const hasReference = referenceImageUrls.length > 0
    || args.referenceVideoUrl !== undefined
    || args.referenceAudioUrl !== undefined
  const hasFrame = args.firstFrameImageUrl !== undefined || args.lastFrameImageUrl !== undefined
  if (hasReference && hasFrame) {
    throw new Error(
      'a MiniMax video request is either image-to-video or reference-based, never both;'
      + ' drop the first or last frame when using reference media',
    )
  }
  const content: MiniMaxVideoCreateRequest['content'] = [{ type: 'text', text: args.prompt }]
  if (hasReference) {
    for (const url of referenceImageUrls) {
      content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
    }
    if (args.referenceVideoUrl !== undefined) {
      content.push({ type: 'video_url', video_url: { url: args.referenceVideoUrl }, role: 'reference_video' })
    }
    if (args.referenceAudioUrl !== undefined) {
      content.push({ type: 'audio_url', audio_url: { url: args.referenceAudioUrl }, role: 'reference_audio' })
    }
  } else {
    if (args.firstFrameImageUrl !== undefined) {
      content.push({ type: 'image_url', image_url: { url: args.firstFrameImageUrl }, role: 'first_frame' })
    }
    if (args.lastFrameImageUrl !== undefined) {
      content.push({ type: 'image_url', image_url: { url: args.lastFrameImageUrl }, role: 'last_frame' })
    }
  }
  return {
    model,
    resolution,
    duration,
    ratio: args.ratio ?? options.ratio,
    content,
    // MiniMax accepts the prompt-expansion switch only for the H3 Max model.
    ...args.promptExpansionMode === undefined || model !== 'MiniMax-H3-Max'
      ? {}
      : { extra: { prompt_expansion_mode: args.promptExpansionMode } },
  }
}

/** The result of one generation call. */
interface GeneratedVideo {
  taskId: string
  status: string
  /** Durable attachment id of the stored MP4, when the task succeeded. */
  attachmentId?: string
  /** Host path of the stored MP4, when the backend is file-backed. */
  path?: string
  /** Download URL MiniMax returned; time-limited. */
  url?: string
}

/**
 * The media items a generation or an enrichment request carries.
 *
 * The frames and the reference media are two exclusive forms, and MiniMax
 * refuses a request that mixes them, so the items are collected here and the
 * form is decided once.
 * @param args - the prompt and the material the caller supplied.
 * @returns the content items the request carries.
 * @throws when the arguments mix frames with reference media.
 */
function contextItems(args: {
  prompt: string
  firstFrameImageUrl?: string
  lastFrameImageUrl?: string
  referenceImageUrls?: readonly string[]
  referenceVideoUrl?: string
  referenceAudioUrl?: string
}): MiniMaxVideoCreateRequest['content'] {
  const referenceImageUrls = args.referenceImageUrls ?? []
  const hasReference = referenceImageUrls.length > 0
    || args.referenceVideoUrl !== undefined
    || args.referenceAudioUrl !== undefined
  const hasFrame = args.firstFrameImageUrl !== undefined || args.lastFrameImageUrl !== undefined
  if (hasReference && hasFrame) {
    throw new Error(
      'a MiniMax video request is either image-to-video or reference-based, never both;'
      + ' drop the first or last frame when using reference media',
    )
  }
  const content: MiniMaxVideoCreateRequest['content'] = [{ type: 'text', text: args.prompt }]
  if (hasReference) {
    for (const url of referenceImageUrls) {
      content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
    }
    if (args.referenceVideoUrl !== undefined) {
      content.push({ type: 'video_url', video_url: { url: args.referenceVideoUrl }, role: 'reference_video' })
    }
    if (args.referenceAudioUrl !== undefined) {
      content.push({ type: 'audio_url', audio_url: { url: args.referenceAudioUrl }, role: 'reference_audio' })
    }
    return content
  }
  if (args.firstFrameImageUrl !== undefined) {
    content.push({ type: 'image_url', image_url: { url: args.firstFrameImageUrl }, role: 'first_frame' })
  }
  if (args.lastFrameImageUrl !== undefined) {
    content.push({ type: 'image_url', image_url: { url: args.lastFrameImageUrl }, role: 'last_frame' })
  }
  return content
}

/**
 * Store a finished video and report where it went.
 * @param ctx - plugin context.
 * @param options - resolved limits.
 * @param taskId - the task the video came from, for the stored file name.
 * @param sourceUrl - the temporary download URL.
 * @param signal - caller cancellation.
 * @returns the attachment id and, when the backend is file-backed, its path.
 */
async function storeVideo(
  ctx: Context,
  options: MiniMaxVideoOptions,
  taskId: string,
  sourceUrl: string,
  signal: AbortSignal | undefined,
): Promise<{ attachmentId?: string; path?: string }> {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return {}
  const ref = await attachments.saveFileStream({
    data: downloadVideo(sourceUrl, options.maxDownloadBytes, signal),
    name: `minimax-${taskId}.mp4`,
    ...signal === undefined ? {} : { signal },
  })
  const path = attachments.fileHostPath(ref)
  return { attachmentId: ref.attachmentId, ...path === undefined ? {} : { path } }
}

/**
 * Register the two video tools.
 * @param ctx - plugin context with the tool registry injected.
 * @param config - endpoints, defaults, and the credential reference.
 */
export function apply(ctx: Context, config: Config): void {
  const section = (): Section => ({
    apiKey: config.apiKey.get(),
    apiKeyEnv: config.apiKeyEnv.get(),
    apiBaseURL: config.apiBaseURL.get(),
    chatBaseURL: config.chatBaseURL.get(),
    videoModel: config.videoModel.get(),
    resolution: config.resolution.get(),
    durationSeconds: config.durationSeconds.get(),
    ratio: config.ratio.get(),
    pollIntervalMs: config.pollIntervalMs.get(),
    pollTimeoutMs: config.pollTimeoutMs.get(),
    maxDownloadBytes: config.maxDownloadBytes.get(),
    maxTokens: config.maxTokens.get(),
    understandingModel: config.understandingModel.get(),
  })

  ctx.tools.register(defineTool({
    name: 'minimax_video_generate',
    description:
      'Generate a short video with MiniMax (text-to-video, or image-to-video from a first frame).'
      + ' Returns the stored file path and the task id. Generation takes minutes, so the call polls until the'
      + ' task settles or its deadline passes.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'What the video should show.' },
      model: {
        type: 'string',
        enum: [...MINIMAX_VIDEO_MODELS],
        description: 'Video model; deployment default when omitted.',
      },
      resolution: {
        type: 'string',
        enum: [...MINIMAX_VIDEO_RESOLUTIONS],
        description: 'Output resolution; deployment default when omitted.',
      },
      durationSeconds: { type: 'number', description: 'Clip length in seconds, 4–15; deployment default when omitted.' },
      ratio: { type: 'string', description: 'Aspect ratio such as 16:9 or 9:16; ignored for image-to-video.' },
      firstFrameImageUrl: { type: 'string', description: 'Public image URL to use as the first frame (image-to-video).' },
      lastFrameImageUrl: { type: 'string', description: 'Public image URL to use as the last frame; pairs with the first frame.' },
      referenceImageUrls: {
        type: 'array',
        items: { type: 'string' },
        description: 'Public image URLs the video should look like; a reference-based request, never combined with frames.',
      },
      referenceVideoUrl: { type: 'string', description: 'Public video URL the result should follow; a reference-based request.' },
      referenceAudioUrl: { type: 'string', description: 'Public audio URL the result should carry; a reference-based request.' },
      promptExpansionMode: {
        type: 'string',
        enum: ['disabled', 'balanced', 'quality'],
        description: 'How hard MiniMax rewrites the prompt; accepted only by MiniMax-H3-Max.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          path: { type: 'string' },
          attachmentId: { type: 'string' },
          url: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.path === undefined
          ? `MiniMax video ${value.taskId} finished with status ${value.status}.`
          : `MiniMax video ${value.taskId} saved to ${value.path}.`,
      }],
      presentationMeta: (_args, value) => ({
        ...value.path === undefined ? {} : { path: value.path },
      }),
    },
    // A generation can legitimately run for minutes.
    timeoutMs: config.pollTimeoutMs.get() + 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const options = await optionsFor(ctx, section(), section().apiKey)
      const taskId = await createVideoTask(options, generationRequest(options, args), exec.signal)
      const task = await waitForVideoTask(options, taskId, exec.signal)
      if (task.status !== 'succeeded') {
        const detail = task.error?.message ?? task.error?.code
        throw new Error(
          `MiniMax video ${taskId} ended ${task.status}${detail === undefined ? '' : `: ${String(detail)}`}`,
        )
      }
      const result: GeneratedVideo = {
        taskId,
        status: task.status,
        ...task.content?.url === undefined || task.content.url === null ? {} : { url: task.content.url },
      }
      if (result.url === undefined) throw new Error(`MiniMax video ${taskId} succeeded without a download URL`)
      const attachments = ctx.get('attachments')
      if (attachments === undefined) return result
      const stream = downloadVideo(result.url, options.maxDownloadBytes, exec.signal)
      const ref = await attachments.saveFileStream({
        data: stream,
        name: `minimax-${taskId}.mp4`,
        signal: exec.signal,
      })
      const path = attachments.fileHostPath(ref)
      return {
        ...result,
        attachmentId: ref.attachmentId,
        ...path === undefined ? {} : { path },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'minimax_video_understand',
    description:
      'Ask MiniMax what happens in a video. Provide a public URL (or an mm_file:// reference from an earlier'
      + ' MiniMax upload) and the question to answer about it.',
    parameters: {
      videoUrl: { type: 'string', required: true, description: 'Public video URL or mm_file:// reference.' },
      prompt: {
        type: 'string',
        description: 'What to answer about the video; defaults to describing what happens in it.',
      },
      fps: { type: 'number', description: 'Frame sampling rate 0.2–5; MiniMax defaults to 1.' },
      detail: {
        type: 'string',
        enum: ['low', 'default', 'high'],
        description: 'Frame detail level; higher costs more tokens.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const options = await optionsFor(ctx, section(), section().apiKey)
      const text = await understandVideo(options, {
        videoUrl: args.videoUrl,
        prompt: args.prompt ?? 'Describe what happens in this video.',
        ...args.fps === undefined ? {} : { fps: args.fps },
        ...args.detail === undefined ? {} : { detail: args.detail },
      }, exec.signal)
      return { text }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'minimax_video_task_list',
    description:
      'List the MiniMax video generation tasks of the last week, newest first.'
      + ' Use it to find a task id, to see which tasks are still running, or to review what was generated.',
    parameters: {
      status: {
        type: 'string',
        enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'],
        description: 'Only tasks in this state; all states when omitted.',
      },
      model: { type: 'string', enum: [...MINIMAX_VIDEO_MODELS], description: 'Only tasks of this model.' },
      taskIds: { type: 'array', items: { type: 'string' }, description: 'Only these task ids.' },
      pageNum: { type: 'number', description: 'Page number, starting at 1.' },
      pageSize: { type: 'number', description: 'How many tasks per page.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          tasks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                taskId: { type: 'string', required: true },
                status: { type: 'string', required: true },
                model: { type: 'string' },
                resolution: { type: 'string' },
                durationSeconds: { type: 'number' },
                ratio: { type: 'string' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.tasks
          .map(task => `${task.taskId} ${task.status}${task.model === undefined ? '' : ` ${task.model}`}`)
          .join('\n'),
      }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const options = await optionsFor(ctx, section(), section().apiKey)
      const listed = await listVideoTasks(options, {
        ...args.status === undefined ? {} : { status: args.status },
        ...args.model === undefined ? {} : { model: args.model },
        ...args.taskIds === undefined ? {} : { taskIds: args.taskIds },
        ...args.pageNum === undefined ? {} : { pageNum: Math.trunc(args.pageNum) },
        ...args.pageSize === undefined ? {} : { pageSize: Math.trunc(args.pageSize) },
      }, exec.signal)
      return {
        total: listed.total,
        tasks: listed.tasks.map(task => ({
          taskId: task.id,
          status: task.status,
          ...task.model === undefined ? {} : { model: task.model },
          ...task.resolution === undefined ? {} : { resolution: task.resolution },
          ...task.duration === undefined ? {} : { durationSeconds: task.duration },
          ...task.ratio === undefined || task.ratio.length === 0 ? {} : { ratio: task.ratio },
          ...task.error?.message === undefined ? {} : { error: task.error.message },
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'minimax_video_task_cancel',
    description:
      'Cancel a MiniMax video task that has not started yet, or delete the record of a task that already'
      + ' finished. A running task cannot be cancelled and MiniMax refuses the call.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'The task id to cancel or delete.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          action: { type: 'string', required: true },
          status: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `MiniMax video ${value.taskId} ${value.action}.` }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const options = await optionsFor(ctx, section(), section().apiKey)
      const outcome = await cancelVideoTask(options, args.taskId, exec.signal)
      return {
        taskId: args.taskId,
        action: outcome.action ?? 'unknown',
        ...outcome.status === undefined ? {} : { status: outcome.status },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'minimax_video_context_enrich',
    description:
      'Turn material into an enriched video prompt with MiniMax. Give it a text, image, video, or audio'
      + ' reference and it returns the prompt a generation should use.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'What the video should show.' },
      durationSeconds: { type: 'number', description: 'Target video length in seconds, 4–15; deployment default when omitted.' },
      ratio: { type: 'string', description: 'Aspect ratio such as 16:9 or 9:16.' },
      firstFrameImageUrl: { type: 'string', description: 'Public image URL to use as the first frame.' },
      lastFrameImageUrl: { type: 'string', description: 'Public image URL to use as the last frame.' },
      referenceImageUrls: { type: 'array', items: { type: 'string' }, description: 'Public image URLs the video should look like.' },
      referenceVideoUrl: { type: 'string', description: 'Public video URL the result should follow.' },
      referenceAudioUrl: { type: 'string', description: 'Public audio URL the result should carry.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          prompt: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.prompt }],
    },
    timeoutMs: config.pollTimeoutMs.get() + 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const options = await optionsFor(ctx, section(), section().apiKey)
      const duration = args.durationSeconds ?? options.durationSeconds
      const content = contextItems({
        prompt: args.prompt,
        ...args.firstFrameImageUrl === undefined ? {} : { firstFrameImageUrl: args.firstFrameImageUrl },
        ...args.lastFrameImageUrl === undefined ? {} : { lastFrameImageUrl: args.lastFrameImageUrl },
        ...args.referenceImageUrls === undefined ? {} : { referenceImageUrls: args.referenceImageUrls },
        ...args.referenceVideoUrl === undefined ? {} : { referenceVideoUrl: args.referenceVideoUrl },
        ...args.referenceAudioUrl === undefined ? {} : { referenceAudioUrl: args.referenceAudioUrl },
      })
      const taskId = await createContextIrTask(options, {
        model: 'MiniMax-H3',
        content,
        duration,
        ...args.ratio === undefined ? {} : { ratio: args.ratio },
      }, exec.signal)
      const task = await waitForVideoTask(options, taskId, exec.signal)
      if (task.status !== 'succeeded') {
        const detail = task.error?.message ?? task.error?.code
        throw new Error(
          `MiniMax context enrichment ${taskId} ended ${task.status}${detail === undefined ? '' : `: ${String(detail)}`}`,
        )
      }
      const prompt = task.content?.prompt
      if (prompt === undefined || prompt === null || prompt.length === 0) {
        throw new Error(`MiniMax context enrichment ${taskId} produced no prompt`)
      }
      return { taskId, prompt }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'minimax_video_regenerate',
    description:
      'Regenerate a finished MiniMax video at 2K, either from the task that produced it or from a'
      + ' 768P source video. The source task must have succeeded within the last week.',
    parameters: {
      sourceTaskId: { type: 'string', description: 'The finished task to regenerate; mutually exclusive with baseVideoUrl.' },
      baseVideoUrl: { type: 'string', description: 'Public URL of a 768P source video; mutually exclusive with sourceTaskId.' },
      prompt: { type: 'string', description: 'The final prompt to send to the model for the regeneration.' },
      firstFrameImageUrl: { type: 'string', description: 'Public image URL to use as the first frame of the regeneration.' },
      lastFrameImageUrl: { type: 'string', description: 'Public image URL to use as the last frame of the regeneration.' },
      watermark: { type: 'boolean', description: 'Append an AIGC watermark tone to the result.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          path: { type: 'string' },
          attachmentId: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.path === undefined
          ? `MiniMax regeneration ${value.taskId} finished with status ${value.status}.`
          : `MiniMax regeneration ${value.taskId} saved to ${value.path}.`,
      }],
      presentationMeta: (_args, value) => ({ ...value.path === undefined ? {} : { path: value.path } }),
    },
    timeoutMs: config.pollTimeoutMs.get() + 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const options = await optionsFor(ctx, section(), section().apiKey)
      if (args.sourceTaskId === undefined && args.baseVideoUrl === undefined) {
        throw new Error('a MiniMax regeneration needs either a source task id or a base video URL')
      }
      if (args.sourceTaskId !== undefined && args.baseVideoUrl !== undefined) {
        throw new Error('a MiniMax regeneration takes a source task id or a base video URL, never both')
      }
      const taskId = await createRegenerationTask(options, {
        model: 'MiniMax-H3',
        resolution: '2K',
        ...args.sourceTaskId === undefined ? {} : { sourceTaskId: args.sourceTaskId },
        ...args.baseVideoUrl === undefined
          ? {}
          : {
            content: [
              ...args.prompt === undefined
                ? []
                : [{ type: 'text' as const, text: args.prompt }],
              { type: 'video_url' as const, video_url: { url: args.baseVideoUrl }, role: 'base_video' as const },
            ],
          },
        ...args.watermark === undefined ? {} : { aigcWatermark: args.watermark },
      }, exec.signal)
      const task = await waitForVideoTask(options, taskId, exec.signal)
      if (task.status !== 'succeeded') {
        const detail = task.error?.message ?? task.error?.code
        throw new Error(
          `MiniMax regeneration ${taskId} ended ${task.status}${detail === undefined ? '' : `: ${String(detail)}`}`,
        )
      }
      const sourceUrl = task.content?.url
      if (sourceUrl === undefined || sourceUrl === null) {
        throw new Error(`MiniMax regeneration ${taskId} succeeded without a download URL`)
      }
      return { taskId, status: task.status, ...(await storeVideo(ctx, options, taskId, sourceUrl, exec.signal)) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'minimax_video_generate_hailuo',
    description:
      'Generate a video with the older MiniMax Hailuo models, which reach 1080P. Supports a prompt alone,'
      + ' a first frame, a first and a last frame, or a character reference. Returns the stored file path.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'What the video should show (≤2000 characters).' },
      model: {
        type: 'string',
        enum: [...MINIMAX_HAILUO_MODELS],
        required: true,
        description: 'Hailuo model; the model must suit the material given.',
      },
      firstFrameImageUrl: { type: 'string', description: 'Public image URL to use as the first frame.' },
      lastFrameImageUrl: { type: 'string', description: 'Public image URL to use as the last frame; needs a first frame too.' },
      subjectReferenceImages: {
        type: 'array',
        items: { type: 'string' },
        description: 'Public image URLs of the character to keep; needs the S2V-01 model.',
      },
      duration: { type: 'number', description: 'Clip length in seconds; the model decides which lengths it serves.' },
      resolution: {
        type: 'string',
        enum: ['512P', '720P', '768P', '1080P'],
        description: 'Output resolution; the model decides which resolutions it serves.',
      },
      promptOptimizer: { type: 'boolean', description: 'Let MiniMax rewrite the prompt; defaults to true.' },
      fastPretreatment: { type: 'boolean', description: 'Faster pretreatment; only the 2.3 and 02 models accept it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          path: { type: 'string' },
          attachmentId: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.path === undefined
          ? `MiniMax video ${value.taskId} finished with status ${value.status}.`
          : `MiniMax video ${value.taskId} saved to ${value.path}.`,
      }],
      presentationMeta: (_args, value) => ({ ...value.path === undefined ? {} : { path: value.path } }),
    },
    timeoutMs: config.pollTimeoutMs.get() + 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const options = await optionsFor(ctx, section(), section().apiKey)
      const subjectImages = args.subjectReferenceImages ?? []
      if (subjectImages.length > 0 && args.model !== 'S2V-01') {
        throw new Error('a character reference needs the S2V-01 model')
      }
      if (args.lastFrameImageUrl !== undefined && args.firstFrameImageUrl === undefined) {
        throw new Error('a last frame needs a first frame to follow')
      }
      const taskId = await createHailuoVideoTask(options, {
        model: args.model,
        prompt: args.prompt,
        ...args.firstFrameImageUrl === undefined ? {} : { firstFrameImageUrl: args.firstFrameImageUrl },
        ...args.lastFrameImageUrl === undefined ? {} : { lastFrameImageUrl: args.lastFrameImageUrl },
        ...subjectImages.length === 0 ? {} : { subjectReference: { imageUrls: subjectImages } },
        ...args.duration === undefined ? {} : { duration: Math.trunc(args.duration) },
        ...args.resolution === undefined ? {} : { resolution: args.resolution },
        ...args.promptOptimizer === undefined ? {} : { promptOptimizer: args.promptOptimizer },
        ...args.fastPretreatment === undefined ? {} : { fastPretreatment: args.fastPretreatment },
      }, exec.signal)
      const task = await waitForHailuoVideoTask(options, taskId, exec.signal)
      if (task.status !== 'Success') {
        throw new Error(`MiniMax video ${taskId} ended ${task.status ?? 'unknown'}`)
      }
      const fileId = task.file_id
      if (fileId === undefined) throw new Error(`MiniMax video ${taskId} succeeded without a file id`)
      const file = await retrieveFile(options, fileId, exec.signal)
      const sourceUrl = file?.download_url
      if (sourceUrl === undefined) throw new Error(`MiniMax file ${fileId} carried no download URL`)
      return { taskId, status: 'succeeded', ...(await storeVideo(ctx, options, taskId, sourceUrl, exec.signal)) }
    },
  }))
}
