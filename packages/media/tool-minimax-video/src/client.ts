/**
 * The MiniMax calls behind the video tools: task creation and polling on the
 * native API host, and video understanding on the Anthropic-compatible root.
 *
 * The two capabilities live on different paths (`/v2/video_generation` versus
 * `/anthropic/v1/messages`), so they take separate base URLs. Everything here
 * is transport and wire mapping; credential resolution and tool registration
 * stay in `index.ts`.
 *
 * @module @deepseek-ai/dsh-tool-minimax-video/client
 */
import type {
  MiniMaxFileResponse,
  MiniMaxHailuoTask,
  MiniMaxMessageResponse,
  MiniMaxRegenerationRequest,
  MiniMaxVideoActionResponse,
  MiniMaxVideoCreateRequest,
  MiniMaxVideoCreateResponse,
  MiniMaxVideoTask,
  MiniMaxVideoTaskListResponse,
  MiniMaxVideoTaskResponse,
} from './types.ts'

/** Attribution sent with every request. */
const USER_AGENT = 'deepseek-harness-tool-minimax-video'

/** Resolved endpoints and limits one call uses. */
export interface MiniMaxVideoOptions {
  /** Native API root, for example `https://api.minimax.cn`. */
  apiBaseURL: string
  /** Anthropic-compatible root, for example `https://api.minimax.cn/anthropic`. */
  chatBaseURL: string
  /** API key for this call. */
  apiKey: string
  /** Model that runs a generation when the caller names none. */
  videoModel: string
  /** Resolution used when the caller names none. */
  resolution: string
  /** Duration used when the caller names none. */
  durationSeconds: number
  /** Aspect ratio used when the caller names none. */
  ratio: string
  /** Delay between two status reads. */
  pollIntervalMs: number
  /** Upper bound on the whole create-and-poll operation. */
  pollTimeoutMs: number
  /** Largest accepted video download, in bytes. */
  maxDownloadBytes: number
  /** Output cap for one understanding turn. */
  maxTokens: number
  /** Model that runs a video-understanding turn. */
  understandingModel: string
}

/** What one understanding call takes. */
export interface UnderstandRequest {
  /** Public URL, `mm_file://{file_id}` reference, or data URI of the video. */
  videoUrl: string
  /** What to answer about the video. */
  prompt: string
  /** Frame sampling rate, `0.2`–`5`; MiniMax defaults to `1`. */
  fps?: number
  /** Understanding detail for the sampled frames. */
  detail?: 'low' | 'default' | 'high'
}

/** Throw the caller's abort reason, or a stable cancellation error. */
function abortError(signal: AbortSignal | undefined): Error {
  if (signal?.aborted === true && signal.reason instanceof Error) return signal.reason
  return new Error('MiniMax video operation aborted')
}

/** Sleep for `ms`, rejecting on abort. */
async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) { reject(abortError(signal)); return }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => { clearTimeout(timer); reject(abortError(signal)) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Join a root and a path without doubling separators. */
function url(root: string, path: string): string {
  return `${root.replace(/\/+$/u, '')}${path}`
}

/** One JSON request with the route's auth headers. */
async function json<T>(
  endpoint: string,
  options: MiniMaxVideoOptions,
  init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown },
  signal: AbortSignal | undefined,
  what: string,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: init.method,
      // Credentials never follow a redirect to another origin.
      redirect: 'error',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        accept: 'application/json',
        'user-agent': USER_AGENT,
        ...init.body === undefined ? {} : { 'content-type': 'application/json' },
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
 * Create one video generation task.
 * @param options - endpoints, model defaults, and credential.
 * @param request - the generation request.
 * @param signal - caller cancellation.
 * @returns the task id to poll.
 */
export async function createVideoTask(
  options: MiniMaxVideoOptions,
  request: MiniMaxVideoCreateRequest,
  signal?: AbortSignal,
): Promise<string> {
  const body = await json<MiniMaxVideoCreateResponse>(
    url(options.apiBaseURL, '/v2/video_generation'),
    options,
    { method: 'POST', body: request },
    signal,
    'MiniMax video creation',
  )
  if (body.task_id === undefined || body.task_id.length === 0) {
    throw new Error('MiniMax video creation returned no task_id')
  }
  return body.task_id
}

/**
 * Read one task's current state.
 * @param options - endpoints and credential.
 * @param taskId - id returned by {@link createVideoTask}.
 * @param signal - caller cancellation.
 * @returns the task as reported now.
 */
export async function queryVideoTask(
  options: MiniMaxVideoOptions,
  taskId: string,
  signal?: AbortSignal,
): Promise<MiniMaxVideoTask> {
  const body = await json<MiniMaxVideoTaskResponse>(
    url(options.apiBaseURL, `/v2/query/video_generation/${encodeURIComponent(taskId)}`),
    options,
    { method: 'GET' },
    signal,
    'MiniMax video query',
  )
  if (body.task === undefined || body.task === null) {
    throw new Error(`MiniMax video query returned no task for ${taskId}`)
  }
  return body.task
}

/**
 * List the generation tasks of the last week.
 * @param options - endpoints and credential.
 * @param request - pagination and filters.
 * @param signal - caller cancellation.
 * @returns the matching tasks and the total count.
 */
export async function listVideoTasks(
  options: MiniMaxVideoOptions,
  request: {
    pageNum?: number
    pageSize?: number
    status?: string
    taskIds?: readonly string[]
    model?: string
    taskType?: string
  },
  signal?: AbortSignal,
): Promise<{ tasks: MiniMaxVideoTask[]; total: number }> {
  const query = new URLSearchParams()
  if (request.pageNum !== undefined) query.set('page_num', String(request.pageNum))
  if (request.pageSize !== undefined) query.set('page_size', String(request.pageSize))
  if (request.status !== undefined) query.set('filter.status', request.status)
  if (request.taskIds !== undefined && request.taskIds.length > 0) {
    query.set('filter.task_ids', request.taskIds.join(','))
  }
  if (request.model !== undefined) query.set('filter.model', request.model)
  if (request.taskType !== undefined) query.set('filter.task_type', request.taskType)
  const suffix = query.size === 0 ? '' : `?${query.toString()}`
  const body = await json<MiniMaxVideoTaskListResponse>(
    url(options.apiBaseURL, `/v2/query/video_generation${suffix}`),
    options,
    { method: 'GET' },
    signal,
    'MiniMax video task listing',
  )
  return { tasks: body.items ?? [], total: body.total ?? 0 }
}

/**
 * Cancel a queued task, or delete the record of a settled one.
 * @param options - endpoints and credential.
 * @param taskId - the task to act on.
 * @param signal - caller cancellation.
 * @returns what MiniMax did with the task.
 */
export async function cancelVideoTask(
  options: MiniMaxVideoOptions,
  taskId: string,
  signal?: AbortSignal,
): Promise<{ action?: string; status?: string }> {
  const body = await json<MiniMaxVideoActionResponse>(
    url(options.apiBaseURL, `/v2/video_generation/${encodeURIComponent(taskId)}`),
    options,
    { method: 'DELETE' },
    signal,
    'MiniMax video task cancellation',
  )
  return {
    ...body.action === undefined ? {} : { action: body.action },
    ...body.status === undefined ? {} : { status: body.status },
  }
}

/**
 * Poll one task until it reaches a terminal state or the deadline passes.
 * @param options - endpoints, polling cadence, and deadline.
 * @param taskId - id returned by {@link createVideoTask}.
 * @param signal - caller cancellation.
 * @returns the terminal task state.
 */
export async function waitForVideoTask(
  options: MiniMaxVideoOptions,
  taskId: string,
  signal?: AbortSignal,
): Promise<MiniMaxVideoTask> {
  const deadline = Date.now() + options.pollTimeoutMs
  for (;;) {
    const task = await queryVideoTask(options, taskId, signal)
    if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') return task
    if (Date.now() >= deadline) {
      throw new Error(
        `MiniMax video task ${taskId} still ${task.status} after ${String(Math.round(options.pollTimeoutMs / 1000))}s;`
        + ' raise pollTimeoutMs or poll the task again with the same id',
      )
    }
    await sleep(options.pollIntervalMs, signal)
  }
}

/**
 * Create one H3-Context-IR task, which turns multimodal material into an
 * enriched prompt a generation can use.
 * @param options - endpoints and credential.
 * @param request - the model, the material, and the target duration.
 * @param signal - caller cancellation.
 * @returns the task id to poll.
 */
export async function createContextIrTask(
  options: MiniMaxVideoOptions,
  request: { model: string; content: MiniMaxVideoCreateRequest['content']; duration: number; ratio?: string },
  signal?: AbortSignal,
): Promise<string> {
  const body = await json<MiniMaxVideoCreateResponse>(
    url(options.apiBaseURL, '/v2/h3_context_ir'),
    options,
    {
      method: 'POST',
      body: {
        model: request.model,
        content: request.content,
        duration: request.duration,
        ...request.ratio === undefined ? {} : { ratio: request.ratio },
      },
    },
    signal,
    'MiniMax context enrichment',
  )
  if (body.task_id === undefined || body.task_id.length === 0) {
    throw new Error('MiniMax context enrichment returned no task_id')
  }
  return body.task_id
}

/**
 * Create one 2K regeneration of a finished video.
 * @param options - endpoints and credential.
 * @param request - the source task or the source media, and the resolution.
 * @param signal - caller cancellation.
 * @returns the task id to poll.
 */
export async function createRegenerationTask(
  options: MiniMaxVideoOptions,
  request: MiniMaxRegenerationRequest,
  signal?: AbortSignal,
): Promise<string> {
  const body = await json<MiniMaxVideoCreateResponse>(
    url(options.apiBaseURL, '/v2/video_regeneration'),
    options,
    {
      method: 'POST',
      body: {
        model: request.model,
        resolution: request.resolution,
        ...request.sourceTaskId === undefined ? {} : { source_task_id: request.sourceTaskId },
        ...request.content === undefined ? {} : { content: request.content },
        ...request.aigcWatermark === undefined ? {} : { aigc_watermark: request.aigcWatermark },
      },
    },
    signal,
    'MiniMax video regeneration',
  )
  if (body.task_id === undefined || body.task_id.length === 0) {
    throw new Error('MiniMax video regeneration returned no task_id')
  }
  return body.task_id
}

/**
 * Create one video task on the older endpoint, whose models reach 1080P.
 *
 * The older endpoint serves four shapes on one path: a prompt alone, a first
 * frame, a first and a last frame, or a subject reference. The body tells them
 * apart, so the tool picks the shape from the material it was given.
 * @param options - endpoints and credential.
 * @param request - the model, the prompt, and the material.
 * @param signal - caller cancellation.
 * @returns the task id to poll.
 */
export async function createHailuoVideoTask(
  options: MiniMaxVideoOptions,
  request: {
    model: string
    prompt: string
    firstFrameImageUrl?: string
    lastFrameImageUrl?: string
    subjectReference?: { imageUrls: string[] }
    duration?: number
    resolution?: string
    promptOptimizer?: boolean
    fastPretreatment?: boolean
  },
  signal?: AbortSignal,
): Promise<string> {
  const body = await json<MiniMaxVideoCreateResponse>(
    url(options.apiBaseURL, '/v1/video_generation'),
    options,
    {
      method: 'POST',
      body: {
        model: request.model,
        prompt: request.prompt,
        ...request.firstFrameImageUrl === undefined ? {} : { first_frame_image: request.firstFrameImageUrl },
        ...request.lastFrameImageUrl === undefined ? {} : { last_frame_image: request.lastFrameImageUrl },
        ...request.subjectReference === undefined
          ? {}
          : { subject_reference: [{ type: 'character', image: request.subjectReference.imageUrls }] },
        ...request.duration === undefined ? {} : { duration: request.duration },
        ...request.resolution === undefined ? {} : { resolution: request.resolution },
        ...request.promptOptimizer === undefined ? {} : { prompt_optimizer: request.promptOptimizer },
        ...request.fastPretreatment === undefined ? {} : { fast_pretreatment: request.fastPretreatment },
      },
    },
    signal,
    'MiniMax Hailuo video creation',
  )
  if (body.task_id === undefined || body.task_id.length === 0) {
    throw new Error('MiniMax Hailuo video creation returned no task_id')
  }
  return body.task_id
}

/**
 * Read one older-endpoint task's state.
 * @param options - endpoints and credential.
 * @param taskId - the task to read.
 * @param signal - caller cancellation.
 * @returns the task state, including the file id once it succeeded.
 */
export async function queryHailuoVideoTask(
  options: MiniMaxVideoOptions,
  taskId: string,
  signal?: AbortSignal,
): Promise<MiniMaxHailuoTask> {
  return await json<MiniMaxHailuoTask>(
    url(options.apiBaseURL, `/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`),
    options,
    { method: 'GET' },
    signal,
    'MiniMax Hailuo video query',
  )
}

/**
 * Poll one older-endpoint task until it settles or the deadline passes.
 * @param options - endpoints, polling cadence, and deadline.
 * @param taskId - the task to poll.
 * @param signal - caller cancellation.
 * @returns the settled task, whose file id is present once it succeeded.
 */
export async function waitForHailuoVideoTask(
  options: MiniMaxVideoOptions,
  taskId: string,
  signal?: AbortSignal,
): Promise<MiniMaxHailuoTask> {
  const deadline = Date.now() + options.pollTimeoutMs
  for (;;) {
    const task = await queryHailuoVideoTask(options, taskId, signal)
    if (task.status === 'Success' || task.status === 'Fail') return task
    if (Date.now() >= deadline) {
      throw new Error(
        `MiniMax video task ${taskId} still ${task.status ?? 'unknown'} after`
        + ` ${String(Math.round(options.pollTimeoutMs / 1000))}s; raise pollTimeoutMs or poll the task again`
        + ' with the same id',
      )
    }
    await sleep(options.pollIntervalMs, signal)
  }
}

/**
 * Read a stored file's metadata and its time-limited download URL.
 * @param options - endpoints and credential.
 * @param fileId - the file to read.
 * @param signal - caller cancellation.
 * @returns the file's metadata, including its download URL.
 */
export async function retrieveFile(
  options: MiniMaxVideoOptions,
  fileId: string,
  signal?: AbortSignal,
): Promise<MiniMaxFileResponse['file']> {
  const body = await json<MiniMaxFileResponse>(
    url(options.apiBaseURL, `/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`),
    options,
    { method: 'GET' },
    signal,
    'MiniMax file retrieval',
  )
  const status = body.base_resp?.status_code
  if (status !== undefined && status !== 0) {
    const detail = body.base_resp?.status_msg
    throw new Error(
      `MiniMax file retrieval failed with status ${String(status)}${detail === undefined ? '' : `: ${detail}`}`,
    )
  }
  return body.file ?? undefined
}

/**
 * Stream a finished video into bounded chunks.
 * @param downloadUrl - the task's `content.url`.
 * @param maxBytes - largest accepted body.
 * @param signal - caller cancellation.
 * @returns the video bytes in order.
 */
export async function* downloadVideo(
  downloadUrl: string,
  maxBytes: number,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  let response: Response
  try {
    // No credentials travel with this request: the URL is a signed CDN link.
    response = await fetch(downloadUrl, { ...signal === undefined ? {} : { signal } })
  } catch (error: unknown) {
    if (signal?.aborted === true) throw abortError(signal)
    throw new Error(`MiniMax video download failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new Error(`MiniMax video download answered HTTP ${String(response.status)}`)
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`MiniMax video is ${String(declared)} bytes, above the ${String(maxBytes)}-byte download limit`)
  }
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) {
      throw new Error(`MiniMax video is ${String(bytes.byteLength)} bytes, above the ${String(maxBytes)}-byte download limit`)
    }
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
      if (total > maxBytes) {
        throw new Error(`MiniMax video exceeds the ${String(maxBytes)}-byte download limit`)
      }
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Ask the model one question about a video.
 * @param options - endpoints, model, and credential.
 * @param request - the video reference and the question.
 * @param signal - caller cancellation.
 * @returns the answer text MiniMax returned.
 */
export async function understandVideo(
  options: MiniMaxVideoOptions,
  request: UnderstandRequest,
  signal?: AbortSignal,
): Promise<string> {
  const body = {
    model: options.understandingModel,
    // MiniMax-M3.1-Flash always thinks and rejects `disabled`.
    thinking: { type: 'adaptive' as const },
    max_tokens: options.maxTokens,
    output_config: { effort: 'low' as const },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: request.prompt },
        {
          type: 'video',
          source: {
            type: 'url',
            url: request.videoUrl,
            ...request.fps === undefined ? {} : { fps: request.fps },
            ...request.detail === undefined ? {} : { detail: request.detail },
          },
        },
      ],
    }],
  }
  const response = await json<MiniMaxMessageResponse>(
    url(options.chatBaseURL, '/v1/messages'),
    options,
    { method: 'POST', body },
    signal,
    'MiniMax video understanding',
  )
  const text = (response.content ?? [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
  if (text.length === 0) {
    throw new Error(`MiniMax returned no text for the video${response.stop_reason === undefined ? '' : ` (stop_reason ${String(response.stop_reason)})`}`)
  }
  return text
}
