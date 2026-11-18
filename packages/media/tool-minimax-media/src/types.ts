/**
 * Wire types for the MiniMax media endpoints.
 *
 * Native endpoints answer `200` with an in-band `base_resp`, so every response
 * type carries that envelope.
 *
 * @module @deepseek-ai/dsh-tool-minimax-media/types
 */

/** In-band status every native MiniMax endpoint returns. */
export interface MiniMaxBaseResp {
  status_code?: number
  status_msg?: string
}

/** Image generation response. */
export interface MiniMaxImageResponse {
  data?: { image_urls?: string[] | null; image_base64?: string[] | null } | null
  metadata?: { success_count?: unknown; failed_count?: unknown } | null
  base_resp?: MiniMaxBaseResp | null
}

/** Speech-synthesis and music responses, which share the audio envelope. */
export interface MiniMaxAudioResponse {
  data?: { audio?: string | null; status?: number } | null
  extra_info?: Record<string, unknown> | null
  base_resp?: MiniMaxBaseResp | null
}

/** One speaker-separated segment of a `verbose_json` transcription. */
export interface MiniMaxTranscriptSegment {
  id?: number
  start?: number
  end?: number
  /** Speaker label such as `S1`. */
  speaker?: string
  text?: string
}

/** Speech-recognition response in its default JSON form. */
export interface MiniMaxTranscription {
  text?: string
  duration?: number
  /** Speaker count, present only in the `verbose_json` form. */
  n_speakers?: number
  /** Speaker-separated segments, present only in the `verbose_json` form. */
  segments?: MiniMaxTranscriptSegment[]
  base_resp?: MiniMaxBaseResp | null
}

/** File upload response. */
export interface MiniMaxFileUploadResponse {
  file?: { file_id?: number; bytes?: number; filename?: string; purpose?: string } | null
  base_resp?: MiniMaxBaseResp | null
}

/** One voice as the voice-management endpoint reports it. */
export interface MiniMaxVoiceEntry {
  voice_id: string
  /** Display name; system voices carry one, cloned and designed voices do not. */
  voice_name?: string
  description?: string[]
  created_time?: string
}

/** The three voice groups the voice-management endpoint returns. */
export type MiniMaxVoiceGroup = 'system_voice' | 'voice_cloning' | 'voice_generation'

/** Voice-management response: one array per voice group. */
export interface MiniMaxVoiceListResponse {
  system_voice?: MiniMaxVoiceEntry[]
  voice_cloning?: MiniMaxVoiceEntry[]
  voice_generation?: MiniMaxVoiceEntry[]
  base_resp?: MiniMaxBaseResp | null
}

/** Voice-cloning response. */
export interface MiniMaxVoiceCloneResponse {
  /** Preview audio URL, present only when a preview was requested and synthesized. */
  demo_audio?: string
  extra_info?: Record<string, unknown> | null
  base_resp?: MiniMaxBaseResp | null
}

/** Voice-design response. */
export interface MiniMaxVoiceDesignResponse {
  /** Generated voice id, usable as `voice_id` in speech synthesis. */
  voice_id?: string
  /** Preview audio, hex-encoded rather than a URL. */
  trial_audio?: string
  base_resp?: MiniMaxBaseResp | null
}

/** Voice-deletion response. */
export interface MiniMaxVoiceDeleteResponse {
  voice_id?: string
  created_time?: string
  base_resp?: MiniMaxBaseResp | null
}

/** Async speech-synthesis task creation response. */
export interface MiniMaxAsyncSpeechResponse {
  /** Task id; a string here and an integer in the query response. */
  task_id?: string
  /** Audio file id, present once the task was created. */
  file_id?: number
  task_token?: string
  usage_characters?: number
  base_resp?: MiniMaxBaseResp | null
}

/** Async speech-synthesis task query response. */
export interface MiniMaxAsyncSpeechStatusResponse {
  task_id?: number
  /** One of `success`, `failed`, `expired`, `processing`. */
  status?: string
  /** Audio file id of the finished synthesis. */
  file_id?: number
  base_resp?: MiniMaxBaseResp | null
}

/** Music cover preprocessing response. */
export interface MiniMaxCoverPreprocessResponse {
  cover_feature_id?: string
  /** Lyrics extracted from the reference audio, with section tags. */
  formatted_lyrics?: string
  /** JSON string describing the song's segment structure. */
  structure_result?: string
  audio_duration?: number
  base_resp?: MiniMaxBaseResp | null
}

/** Lyrics generation response. */
export interface MiniMaxLyricsResponse {
  song_title?: string
  style_tags?: string
  lyrics?: string
  base_resp?: MiniMaxBaseResp | null
}

/** One stored file as the file endpoints report it. */
export interface MiniMaxFileEntry {
  file_id?: number
  bytes?: number
  created_at?: number
  filename?: string
  purpose?: string
  /** Time-limited download URL; present on the retrieve response. */
  download_url?: string
}

/** The file-list endpoint's envelope. */
export interface MiniMaxFileListResponse {
  files?: MiniMaxFileEntry[] | null
  base_resp?: MiniMaxBaseResp | null
}

/** The file-retrieve endpoint's envelope. */
export interface MiniMaxFileRetrieveResponse {
  file?: MiniMaxFileEntry | null
  base_resp?: MiniMaxBaseResp | null
}

/** The file-deletion endpoint's envelope. */
export interface MiniMaxFileDeleteResponse {
  file_id?: number
  base_resp?: MiniMaxBaseResp | null
}

/** The token-counting endpoint's envelope. */
export interface MiniMaxCountTokensResponse {
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  } | null
  base_resp?: MiniMaxBaseResp | null
}
