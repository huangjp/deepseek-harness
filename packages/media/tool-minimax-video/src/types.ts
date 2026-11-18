/**
 * Wire types for the MiniMax video endpoints the video tools call.
 *
 * @module @deepseek-ai/dsh-tool-minimax-video/types
 */

/** One video generation task as the query endpoint reports it. */
export interface MiniMaxVideoTask {
  id: string
  model?: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  /** Download URL for the finished video; time-limited. */
  content?: { url?: string | null; prompt?: string | null } | null
  /** Failure detail, present only when `status` is `failed`. */
  error?: { code?: number | string; message?: string } | null
  usage?: Record<string, unknown> | null
  /** Creation time and last update, as Unix seconds. */
  created_at?: number
  updated_at?: number
  /** The generation's own kind. */
  task_type?: 'generation' | 'h3_context_ir' | 'regeneration'
  /** Which modality the task produced. */
  modality?: 'video' | 'text'
  /** The task's resolution and duration, as created. */
  resolution?: string
  duration?: number
  ratio?: string
}

/** The query endpoint's envelope. */
export interface MiniMaxVideoTaskResponse {
  task?: MiniMaxVideoTask | null
}

/** The create endpoint's envelope. */
export interface MiniMaxVideoCreateResponse {
  task_id?: string
}

/** The task-list endpoint's envelope. */
export interface MiniMaxVideoTaskListResponse {
  items?: MiniMaxVideoTask[] | null
  total?: number
}

/** The cancel/delete endpoint's envelope. */
export interface MiniMaxVideoActionResponse {
  task_id?: string
  action?: 'cancelled' | 'deleted'
  status?: string
}

/**
 * The role a media item plays in a generation.
 *
 * A generation is either an image-to-video one (a first frame, optionally a
 * last frame) or a reference one (reference images, video, and audio), never
 * both — MiniMax refuses a request that mixes them.
 */
export type MiniMaxVideoRole =
  | 'first_frame'
  | 'last_frame'
  | 'reference_image'
  | 'reference_video'
  | 'reference_audio'

/** One content item of a creation request. */
export type MiniMaxVideoContent =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string }; role: Extract<MiniMaxVideoRole, 'first_frame' | 'last_frame' | 'reference_image'> }
  | { type: 'video_url'; video_url: { url: string }; role: 'reference_video' }
  | { type: 'audio_url'; audio_url: { url: string }; role: 'reference_audio' }

/** Request body for one creation. */
export interface MiniMaxVideoCreateRequest {
  model: string
  content: MiniMaxVideoContent[]
  resolution: string
  duration: number
  ratio: string
  /** Prompt-expansion strength; MiniMax accepts it only for the H3 Max model. */
  extra?: { prompt_expansion_mode: 'disabled' | 'balanced' | 'quality' }
}

/** One response block of the Messages endpoint. */
export type MiniMaxMessageBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

/** A non-streaming Messages response. */
export interface MiniMaxMessageResponse {
  content?: readonly MiniMaxMessageBlock[] | null
  stop_reason?: string | null
}

/** The roles a regeneration request's content items may carry. */
export type MiniMaxRegenerationRole =
  | 'base_video'
  | 'first_frame'
  | 'last_frame'
  | 'reference_image'
  | 'reference_video'
  | 'reference_audio'

/** One content item of a regeneration request. */
export type MiniMaxRegenerationContent =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string }; role: Extract<MiniMaxRegenerationRole, 'first_frame' | 'last_frame' | 'reference_image'> }
  | { type: 'video_url'; video_url: { url: string }; role: 'base_video' | 'reference_video' }
  | { type: 'audio_url'; audio_url: { url: string }; role: 'reference_audio' }

/** Request body for a 2K regeneration of a finished video. */
export interface MiniMaxRegenerationRequest {
  model: string
  resolution: string
  /** The finished task to regenerate, when the regeneration starts from it. */
  sourceTaskId?: string
  /** The media the regeneration starts from, when it starts from a video. */
  content?: MiniMaxRegenerationContent[]
  aigcWatermark?: boolean
}

/** The v1 query endpoint's task state. */
export interface MiniMaxHailuoTask {
  task_id?: string
  /** One of `Preparing`, `Queueing`, `Processing`, `Success`, `Fail`. */
  status?: string
  /** File id of the finished video, present once the task succeeded. */
  file_id?: string
  video_width?: number
  video_height?: number
  base_resp?: { status_code?: number; status_msg?: string } | null
}

/** The file endpoint's metadata, as the v1 video flow reads it. */
export interface MiniMaxFileResponse {
  file?: {
    file_id?: number
    bytes?: number
    created_at?: number
    filename?: string
    purpose?: string
    /** Time-limited download URL of the stored file. */
    download_url?: string
  } | null
  base_resp?: { status_code?: number; status_msg?: string } | null
}
